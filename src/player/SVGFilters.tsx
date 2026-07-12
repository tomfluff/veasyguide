// Ported from VeasyGuide. Change vs original: the filters were inside a `hidden`
// (display:none) Box — Firefox can drop filter references inside display:none
// subtrees, and the README already documents Firefox trouble with these filters.
// Rendered visually-empty instead (zero-size SVGs need no wrapper hiding).
// Known upstream note: Firefox has issues with feMorphology over backdrop-filter.

const SVGFilters = () => (
  <>
    <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
      <defs>
        <filter id="svgf-thicker-[dark]">
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
    <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
      <defs>
        <filter id="svgf-thicker">
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
