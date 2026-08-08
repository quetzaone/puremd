# Extended mode fixture

Open this file, then switch the security chip from **Safe mode** to **Extended
mode**. Every case below is expected to behave differently in the two modes.

## 1. Relative image from a subfolder

Works in Extended mode without any extra permission.

![inside](media/inside.png)

## 2. Large image — for the lightbox

Click it. The overlay opens with the image contained in the window and never
upscaled. A click on the image, a click outside, the close button and Esc all
close it — the lightbox has one state.

![large](media/large.png)

## 3. Image outside the document folder

Shows *outside the document folder — click to allow*. Clicking it offers the
native dialog; pick `outside.png` there and this image appears.

![outside](../extended-outside/outside.png)

## 4. Embedded data: image

Carries its own bytes, so it needs no folder and no saved file.

![embedded](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAAB0UlEQVR4nO3SsQ2AMAADwYyTmZiOTUlNkQ4J5XXWDeDix2MW2vj7gNmXE7SlJmhL7RX0vG44jqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUrZBm50+QVtqgrbUBG2pLftdsgETNFR6AAAAAElFTkSuQmCC)

## 5. Failures that must stay failures

A file that is not there:

![missing](media/nowhere.png)

A `.png` whose bytes are a GIF:

![mismatch](media/mismatch.png)

An absolute path, a site-root-relative path, and a parent-directory escape:

![site root](/images/logo.png)

![absolute](/Windows/System32/drivers/etc/hosts)

![escape](../../../../Windows/win.ini)

## 6. Remote images — needs an internet connection

Nothing here is requested until you ask. In Safe mode there is no way to ask at
all; in Extended mode the toolbar grows a **Load N images** button, and each
placeholder can be clicked on its own. Both routes name the servers first.

A raster image, which should appear once loaded:

![raster](https://picsum.photos/240/160)

An SVG badge, which loads and is then rejected because SVG is not a supported
format — the placeholder should say so rather than showing the badge:

![badge](https://img.shields.io/badge/svg-not%20supported-red.svg)

After loading, the sidebar security block should list the hosts with a Revoke
action. Revoke, switch to Safe mode, or close the tab, and these go back to
placeholders.

## 7. Allowed HTML

<details>
<summary>A collapsed section</summary>

Inside a `details` block: **bold**, a [link](https://example.com), and a list.

- one
- two

</details>

Press <kbd>Ctrl</kbd> + <kbd>K</kbd> for the command palette. <mark>Highlighted
text</mark>, H<sub>2</sub>O, and 10<sup>6</sup>.

## 8. HTML that must never render

<script>alert("script")</script>

<img src="x" onerror="alert('handler')">

<iframe src="https://example.com"></iframe>

<style>body { display: none }</style>

<svg onload="alert('svg')"><circle r="40" /></svg>

<a href="javascript:alert('uri')">javascript: link</a>

<details open ontoggle="alert('toggle')"><summary>Handler on an allowed tag</summary>body</details>
