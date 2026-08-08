import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { invoke } from "@tauri-apps/api/core";
import { isAllowedWebUrl } from "./linkPolicy";
import { sanitizeSchemaFor, urlTransformFor } from "./sanitize";
import {
  BrokenImageIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  ShieldIcon
} from "../ui/icons";

export const MAX_IMAGES_PER_DOCUMENT = 100;

/**
 * A README with fifty badges would otherwise open fifty sockets the moment it
 * renders and starve the command thread pool, since every fetch blocks one.
 * Four at a time is what a browser allows per host and is plenty here.
 */
const REMOTE_FETCH_LIMIT = 4;
let activeRemoteFetches = 0;
const waitingForSlot: (() => void)[] = [];

function acquireRemoteSlot() {
  if (activeRemoteFetches < REMOTE_FETCH_LIMIT) {
    activeRemoteFetches += 1;
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => waitingForSlot.push(resolve));
}

function releaseRemoteSlot() {
  const next = waitingForSlot.shift();
  if (next) {
    next();
  } else {
    activeRemoteFetches -= 1;
  }
}

export type ImageFailure =
  | "blocked"
  | "remote"
  | "remoteUnsaved"
  | "remoteFailed"
  | "missing"
  | "unauthorized"
  | "outsideFolder"
  | "unsupported"
  | "tooLarge"
  | "tooMany";

export type ImageNotes = Record<ImageFailure, string>;

/**
 * Granting a permission must not re-render the preview: as a prop it would
 * re-parse the whole document — remark, rehype-raw's HTML parser and the
 * sanitizer — to help at most one image. The images that care subscribe here
 * instead, and the preview never hears about it.
 */
const retryListeners = new Set<(all: boolean) => void>();

/** After a grant: only the failures a permission can fix ask again. */
export function retryFailedImages() {
  for (const listener of [...retryListeners]) {
    listener(false);
  }
}

/** After a revoke: everything reloads, so what is no longer allowed disappears. */
export function retryAllImages() {
  for (const listener of [...retryListeners]) {
    listener(true);
  }
}

export type LightboxImage = {
  url: string;
  alt: string;
  source: string;
  width: number;
  height: number;
};

/** Rust answers with stable codes so the reason survives into the reader's language. */
const failureByCode: Record<string, ImageFailure> = {
  "image-missing": "missing",
  "image-unauthorized": "unauthorized",
  "image-outside-folder": "outsideFolder",
  "image-unsupported": "unsupported",
  "image-too-large": "tooLarge",
  "image-remote-blocked": "remote",
  "image-remote-failed": "remoteFailed"
};

/**
 * Tauri hands a raw response back as an ArrayBuffer, but the shape depends on
 * the IPC transport, so accept whatever it is rather than trusting one form —
 * a number array silently stringifies inside a Blob and yields a broken image.
 */
function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
  }

  return Uint8Array.from(value as number[]);
}

/**
 * The Blob has to carry a type. A blob URL is served with its Blob's type as
 * the content type, and an image with none is not guaranteed to decode. Rust
 * already refused anything that is not one of these four, so this picks a label
 * rather than deciding admission — but it reads the same signatures
 * `image_mime_from_bytes` does, because two tables that have to agree should be
 * looking at the same bytes. This one used to check two of them, and called a
 * file WebP on the strength of a single letter.
 */
function imageMime(bytes: Uint8Array) {
  const at = (offset: number, signature: string) =>
    [...signature].every((symbol, index) => bytes[offset + index] === symbol.charCodeAt(0));

  if (at(0, "\x89PNG\r\n\x1a\n")) {
    return "image/png";
  }
  if (at(0, "\xff\xd8\xff")) {
    return "image/jpeg";
  }
  if (at(0, "GIF87a") || at(0, "GIF89a")) {
    return "image/gif";
  }
  if (bytes.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) {
    return "image/webp";
  }

  return "application/octet-stream";
}

export function hostOf(source: string) {
  try {
    return new URL(source).host;
  } catch {
    return source;
  }
}

function imageName(source: string) {
  if (source.startsWith("data:")) {
    return source.slice(0, source.indexOf(";") + 1 || 16);
  }

  return source.split(/[\\/]/).pop() || source;
}

/** Four of the reasons lead somewhere when clicked. The rest only explain. */
const actionableFailures: ImageFailure[] = ["blocked", "remote", "outsideFolder", "unauthorized"];

function failureIcon(failure: ImageFailure) {
  if (failure === "blocked") {
    return <ShieldIcon size={18} />;
  }
  if (failure === "remote") {
    return <DownloadIcon size={18} />;
  }
  if (failure === "outsideFolder") {
    return <FolderIcon size={18} />;
  }
  if (failure === "unauthorized") {
    return <FileIcon size={18} />;
  }

  return <BrokenImageIcon />;
}

/**
 * Decides which placeholder a reader gets before anything is read. Returning
 * null is the only path that asks Rust for bytes.
 */
function refuseImage(
  source: string | undefined,
  extended: boolean,
  documentPath: string | null,
  remoteAllowed: string[]
): ImageFailure | null {
  if (!extended) {
    return "blocked";
  }
  if (!source) {
    return "missing";
  }
  if (isAllowedWebUrl(source)) {
    // Rust checks the approval again before it opens a connection; this only
    // decides whether to bother it, and whether the reader is offered the load.
    if (remoteAllowed.includes(source)) {
      return null;
    }

    return documentPath ? "remote" : "remoteUnsaved";
  }
  if (!source.startsWith("data:") && !documentPath) {
    return "missing";
  }

  return null;
}

function ImageNotice({
  source,
  failure,
  note,
  onClick
}: {
  source: string;
  failure: ImageFailure;
  note: string;
  onClick: () => void;
}) {
  // Both grades stay buttons — all nine open a dialog. The grade promises what
  // kind of dialog, not whether there is one.
  const actionable = actionableFailures.includes(failure);

  return (
    <button
      type="button"
      className={actionable ? "pm-blocked-image is-actionable" : "pm-blocked-image is-note"}
      onClick={onClick}
      title={source}
    >
      {failureIcon(failure)}
      <span>
        <span className="pm-blocked-name">{imageName(source)}</span>
        <span className="pm-blocked-note">{note}</span>
      </span>
      {actionable && <ChevronRightIcon />}
    </button>
  );
}

type DocumentImageProps = {
  src: string;
  alt?: string;
  title?: string;
  documentPath: string | null;
  notes: ImageNotes;
  onNotice: (source: string, failure: ImageFailure) => void;
  onOpen: (image: LightboxImage) => void;
};

function DocumentImage({
  src,
  alt,
  title,
  documentPath,
  notes,
  onNotice,
  onOpen
}: DocumentImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<ImageFailure | null>(null);
  const remote = isAllowedWebUrl(src);
  // Only a remote image has a wait worth showing; a file or a data: URI is
  // there before the next paint.
  const [waiting, setWaiting] = useState(remote);
  const [attempt, setAttempt] = useState(0);

  // A new permission can turn a failure into an image, but it never invalidates
  // one that already loaded, and it cannot conjure a file that is not there or
  // make an unsupported format supported. Only the failures a permission can
  // actually fix ask again; a revoke reloads everything.
  const failureRef = useRef(failure);
  failureRef.current = failure;

  useEffect(() => {
    const listener = (all: boolean) => {
      const current = failureRef.current;
      if (all || current === "outsideFolder" || current === "remoteFailed" || current === "unauthorized") {
        setAttempt((value) => value + 1);
      }
    };

    retryListeners.add(listener);
    return () => {
      retryListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let nextObjectUrl: string | null = null;
    let holdsSlot = false;
    // The placeholder deliberately stays up while a retry runs. Clearing it
    // first renders nothing for a beat, so the document collapses by that much
    // and springs back — on a page with several placeholders that reads as every
    // image blinking at once.
    setWaiting(remote);

    async function load() {
      try {
        if (remote) {
          await acquireRemoteSlot();
          holdsSlot = true;
        }
        if (disposed) {
          return;
        }

        // Three sources, one shape: a data: URI carries its own bytes, a file
        // is read from disk, a remote image is fetched by Rust. All three come
        // back as bytes and become a Blob URL here, never a src the WebView
        // resolves itself.
        const response = await (src.startsWith("data:")
          ? invoke("read_data_image", { imageSource: src })
          : remote
            ? invoke("fetch_remote_image", { documentPath, imageSource: src })
            : invoke("read_local_image", { documentPath, imageSource: src }));

        if (!disposed) {
          const bytes = toBytes(response);
          nextObjectUrl = URL.createObjectURL(new Blob([bytes], { type: imageMime(bytes) }));
          setObjectUrl(nextObjectUrl);
          setFailure(null);
        }
      } catch (error) {
        if (!disposed) {
          setObjectUrl(null);
          setFailure(failureByCode[String(error)] || "missing");
        }
      } finally {
        if (holdsSlot) {
          releaseRemoteSlot();
        }
        if (!disposed) {
          setWaiting(false);
        }
      }
    }

    void load();

    return () => {
      disposed = true;
      if (nextObjectUrl) {
        URL.revokeObjectURL(nextObjectUrl);
      }
    };
  }, [attempt, documentPath, remote, src]);

  if (failure) {
    return (
      <ImageNotice
        source={src}
        failure={failure}
        note={notes[failure]}
        onClick={() => onNotice(src, failure)}
      />
    );
  }

  if (waiting) {
    // Names the host, not the URL — the same unit the reader consented to.
    return (
      <div className="pm-img-loading">
        <span>{hostOf(src)}</span>
      </div>
    );
  }

  if (!objectUrl) {
    return null;
  }

  // A button rather than a click handler on the image: opening the lightbox has
  // to work from the keyboard too, and a button gets that for free.
  return (
    <button
      type="button"
      className="pm-zoom"
      onClick={(event) => {
        const image = event.currentTarget.querySelector("img");
        onOpen({
          url: objectUrl,
          alt: alt || "",
          source: src,
          width: image?.naturalWidth || 0,
          height: image?.naturalHeight || 0
        });
      }}
    >
      {/* No `loading="lazy"`: the bytes are already in memory behind this Blob
          URL, so deferring buys nothing and costs a visible pop-in. WebView2
          says so itself — "Images loaded lazily and replaced with placeholders.
          Load events are deferred." */}
      <img src={objectUrl} alt={alt || ""} title={title} decoding="async" />
    </button>
  );
}

type MarkdownPreviewProps = {
  content: string;
  documentPath: string | null;
  extended: boolean;
  remoteAllowed: string[];
  notes: ImageNotes;
  onBlockedLink: () => void;
  onOpenLink: (href: string) => void;
  onImageNotice: (source: string, failure: ImageFailure) => void;
  onOpenImage: (image: LightboxImage) => void;
};

function MarkdownPreview({
  content,
  documentPath,
  extended,
  remoteAllowed,
  notes,
  onBlockedLink,
  onOpenLink,
  onImageNotice,
  onOpenImage
}: MarkdownPreviewProps) {
  let imageCount = 0;

  return (
    <article className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransformFor(extended)}
        // rehype-raw has to run before rehype-sanitize, otherwise raw HTML is
        // still a text node while the sanitizer looks at the tree and only
        // becomes elements afterwards — unchecked. Safe mode does not parse
        // raw HTML at all.
        rehypePlugins={
          extended
            ? [rehypeRaw, [rehypeSanitize, sanitizeSchemaFor(true)]]
            : [[rehypeSanitize, sanitizeSchemaFor(false)]]
        }
        components={{
          a({ href, children }) {
            const safeHref = href || "";
            const blocked = !isAllowedWebUrl(safeHref);

            return (
              <a
                href="#"
                aria-disabled={blocked}
                onClick={(event) => {
                  event.preventDefault();
                  if (blocked) {
                    onBlockedLink();
                  } else {
                    onOpenLink(safeHref);
                  }
                }}
              >
                {children}
              </a>
            );
          },
          summary({ children }) {
            // The disclosure marker is an inline SVG rather than a CSS
            // background: the app's CSP allows no data: URIs, and the icon
            // family is stroked anyway.
            return (
              <summary>
                <ChevronRightIcon />
                <span>{children}</span>
              </summary>
            );
          },
          img({ src, alt, title }) {
            const source = src || alt || "image";
            let failure = refuseImage(src, extended, documentPath, remoteAllowed);

            // The ceiling counts images that actually cost something. A
            // placeholder costs nothing, so refusing one must not push the
            // next real image over the limit.
            if (!failure) {
              imageCount += 1;
              if (imageCount > MAX_IMAGES_PER_DOCUMENT) {
                failure = "tooMany";
              }
            }

            if (failure) {
              return (
                <ImageNotice
                  source={source}
                  failure={failure}
                  note={notes[failure]}
                  onClick={() => onImageNotice(source, failure)}
                />
              );
            }

            return (
              <DocumentImage
                src={src as string}
                alt={alt || undefined}
                title={title}
                documentPath={documentPath}
                notes={notes}
                onNotice={onImageNotice}
                onOpen={onOpenImage}
              />
            );
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}

/**
 * Memoised on purpose, and the props above are all stable by construction.
 *
 * `ReactMarkdown` re-parses the whole document inside its own render — remark,
 * remark-gfm, remark-rehype, rehype-raw's HTML parser and the sanitizer, every
 * time. The shell re-renders on every scroll frame to move the minimap, so
 * without this the reader pays for a full re-parse per frame and the scrolling
 * visibly stutters.
 */
export default memo(MarkdownPreview);
