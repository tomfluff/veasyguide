// SVG filter definitions used by the highlight and magnification enhance layers.
//
// These are referenced with a regular CSS `filter: url(#…)`, NOT `backdrop-filter`.
// That distinction matters: `backdrop-filter: url(#…)` is unsupported in Firefox AND
// Safari, and Firefox doesn't merely ignore it — the element fails to render at all
// (bugzilla 1787623). Regular `filter: url(#…)` works in every current browser, which
// is why both enhance layers draw the video into a canvas and filter the canvas.
// See docs/decisions.md D14.

const SVGFilters = () => (
  <>
    {/* Thickens DARK ink on a LIGHT slide: erode grows the dark regions.
        Contrast is stretched around the morphology so thin strokes survive it. */}
    <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
      <defs>
        <filter id="svgf-bold-dark">
          <feComponentTransfer in="SourceGraphic">
            <feFuncR type="linear" slope="0.8" intercept="0.2" />
            <feFuncG type="linear" slope="0.8" intercept="0.2" />
            <feFuncB type="linear" slope="0.8" intercept="0.2" />
          </feComponentTransfer>
          <feMorphology operator="erode" radius="1" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="1.5" intercept="-0.25" />
            <feFuncG type="linear" slope="1.5" intercept="-0.25" />
            <feFuncB type="linear" slope="1.5" intercept="-0.25" />
          </feComponentTransfer>
          <feColorMatrix type="saturate" values="2" />
        </filter>
      </defs>
    </svg>

    {/* Thickens LIGHT ink on a DARK slide: dilate grows the light regions. */}
    <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
      <defs>
        <filter id="svgf-bold-light">
          <feComponentTransfer in="SourceGraphic">
            <feFuncR type="linear" slope="0.8" intercept="0.2" />
            <feFuncG type="linear" slope="0.8" intercept="0.2" />
            <feFuncB type="linear" slope="0.8" intercept="0.2" />
          </feComponentTransfer>
          <feMorphology operator="dilate" radius="1" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="1.5" intercept="-0.25" />
            <feFuncG type="linear" slope="1.5" intercept="-0.25" />
            <feFuncB type="linear" slope="1.5" intercept="-0.25" />
          </feComponentTransfer>
          <feColorMatrix type="saturate" values="2" />
        </filter>
      </defs>
    </svg>

    {/* Edge enhancement — a real unsharp-style convolution, not a contrast bump. */}
    <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
      <defs>
        <filter id="svgf-sharpen">
          <feConvolveMatrix
            order="3"
            preserveAlpha="true"
            kernelMatrix="0 -1 0  -1 5 -1  0 -1 0"
          />
        </filter>
      </defs>
    </svg>

    <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
      <defs>
        <filter id="svgf-invert">
          <feComponentTransfer in="SourceGraphic">
            <feFuncR type="table" tableValues="1 0" />
            <feFuncG type="table" tableValues="1 0" />
            <feFuncB type="table" tableValues="1 0" />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
  </>
);

export default SVGFilters;
