// Every icon is an inline SVG on currentColor, drawn at the size the design asks for.
type IconProps = { size?: number };

export function MenuIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2 3.5 H12 M2 7 H12 M2 10.5 H12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function FileIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 1.8 H9.5 L13 5.3 V14 a.4.4 0 0 1 -.4.4 H3.4 A.4.4 0 0 1 3 14 V2.2 A.4.4 0 0 1 3.4 1.8 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FileLinesIcon({ size = 19 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 1.8 H9.5 L13 5.3 V14 a.4.4 0 0 1 -.4.4 H3.4 A.4.4 0 0 1 3 14 V2.2 A.4.4 0 0 1 3.4 1.8 Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M5.4 8.4 H10.6 M5.4 11 H9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function FolderIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4 A1.5 1.5 0 0 1 3 2.5 H6 L8 4.5 H13 A1.5 1.5 0 0 1 14.5 6 V12 A1.5 1.5 0 0 1 13 13.5 H3 A1.5 1.5 0 0 1 1.5 12 Z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

export function PlusIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3 V13 M3 8 H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function SaveIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 2.5 H10.5 L13.5 5.5 V13.5 H2.5 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <rect x="5" y="9" width="6" height="4.5" fill="currentColor" />
    </svg>
  );
}

export function PencilIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <path
        d="M1.5 9.5 L2.2 7 L7.8 1.4 A1 1 0 0 1 9.2 1.4 L9.6 1.8 A1 1 0 0 1 9.6 3.2 L4 8.8 Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SearchIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="5.2" cy="5.2" r="3.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 8 L10.6 10.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function ShieldIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size * (13 / 12)} viewBox="0 0 12 13" fill="none" aria-hidden="true">
      <path
        d="M6 1.2 L10.6 3 V6.2 C10.6 9.3 8.7 11 6 12 C3.3 11 1.4 9.3 1.4 6.2 V3 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PanelIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="1" y="1.5" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.6 1.5 V10.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function EyeIcon() {
  return (
    <svg width="13" height="10" viewBox="0 0 12 9" aria-hidden="true">
      <ellipse cx="6" cy="4.5" rx="5" ry="3.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <circle cx="6" cy="4.5" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function ChevronsIcon() {
  return (
    <svg width="12" height="10" viewBox="0 0 14 10" aria-hidden="true">
      <path
        d="M4.5 1.5 L1.5 5 L4.5 8.5 M9.5 1.5 L12.5 5 L9.5 8.5"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WarningIcon() {
  return (
    <svg width="14" height="13" viewBox="0 0 14 13" aria-hidden="true">
      <path d="M7 1 L13 12 H1 Z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
      <path d="M7 5 V8.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="7" cy="10.2" r=".8" fill="currentColor" />
    </svg>
  );
}

export function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M5.6 8.4 L8.4 5.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M7.7 4.2 L9.1 2.8 A2 2 0 0 1 11.9 5.6 L10.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M6.3 9.8 L4.9 11.2 A2 2 0 0 1 2.1 8.4 L3.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** The slash is deliberately not red: an image that did not load is not a
 *  destructive action, and red is reserved for those. */
export function BrokenImageIcon({ size = 17 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.2" y="3.2" width="15.6" height="13.6" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="7.2" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.4 14.4 L7.8 10.6 L11 13.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.6 16.4 L16.4 3.6" stroke="#5a6779" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Used for the `summary` disclosure marker and as the trailing hint on an
 *  actionable placeholder, so both rotate and read as one family. */
export function ChevronRightIcon({ size = 12 }: IconProps) {
  return (
    <svg width={(size * 7) / 12} height={size} viewBox="0 0 7 12" fill="none" aria-hidden="true">
      <path
        d="M1.4 1.4 L5.6 6 L1.4 10.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CloudDownloadIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.4 10.4 A2.6 2.6 0 0 1 4.7 5.3 A3.4 3.4 0 0 1 11.2 5.6 A2.5 2.5 0 0 1 11.6 10.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 8.2 V13.4 M5.9 11.4 L8 13.6 L10.1 11.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DownloadIcon({ size = 11 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2 V10 M4.6 6.8 L8 10.2 L11.4 6.8 M2.6 13.4 H13.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon({ size = 8 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 5.2 L4.2 7.4 L8 2.8" stroke="#ffffff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function WinMinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1.5 5 H8.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function WinMaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="1.8" y="1.8" width="6.4" height="6.4" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

export function WinRestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="1.4" y="3" width="5.6" height="5.6" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M3.4 3 V1.4 H8.6 V6.6 H7" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

export function WinCloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
