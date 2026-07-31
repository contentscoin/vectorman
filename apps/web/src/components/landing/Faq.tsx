const ITEMS = [
  {
    q: 'How is this different from other vectorization tools?',
    a: 'Two things. Paths are fitted with least-squares Bézier curves and corner detection, so a traced circle is a handful of nodes rather than hundreds. And adjacent colors share a single fitted boundary instead of each fitting their own copy, which is what removes the hairline seams that show up between regions in most tracers.',
  },
  {
    q: 'What image formats can I upload?',
    a: 'PNG, JPG, WebP and GIF. PNG is best because it carries transparency and has no compression artifacts. A heavily compressed JPG still works — noise is detected and cleaned up automatically — but it will never beat a clean source.',
  },
  {
    q: 'Does my image get uploaded anywhere?',
    a: 'No. Decoding and tracing both happen in your browser, in a Web Worker. There is no server involved in a conversion, which is why the free tier has no limit.',
  },
  {
    q: 'Can I use the vectors commercially?',
    a: 'Yes. Anything you convert is yours. You are responsible for having the rights to the image you started from.',
  },
  {
    q: 'Which design tools open the output?',
    a: 'The SVG is plain, standards-compliant markup with one group per color, so Illustrator, Figma, Inkscape, Affinity Designer, Sketch and Canva all open it. PDF and EPS are for print shops, and DXF is for laser cutters and CNC, where curves are flattened to polylines because spline support in CAM software is unreliable.',
  },
  {
    q: 'Why is my text not editable?',
    a: 'Because the font is not recoverable from pixels. Letters come back as the shapes they looked like, which is correct for printing and cutting but means you cannot retype them. If you need live text, set it again in your design tool.',
  },
  {
    q: 'What do "pieces" and "nodes" mean?',
    a: 'Pieces are separate filled regions — a dotted outline of 20 dots is 20 pieces. Nodes are anchor points, the handles you would drag when editing. A high piece count on simple art usually means leftover speckle, and a high node count means the paths will be painful to edit.',
  },
  {
    q: 'Is there an API or plugin?',
    a: 'Yes. The same engine ships as an MCP server, so an AI assistant can analyze an image, convert it, inspect the palette and merge colors without leaving the conversation.',
  },
];

export function Faq() {
  return (
    <section id="faq" className="section py-20 sm:py-28">
      <div className="max-w-2xl">
        <p className="eyebrow">Frequently asked questions</p>
        <h2 className="heading-lg mt-3 text-balance">Questions before you convert?</h2>
      </div>

      <div className="mt-10 grid gap-3 lg:grid-cols-2">
        {ITEMS.map((item) => (
          <details
            key={item.q}
            className="group rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 open:bg-ink-850"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-ink-100">
              {item.q}
              <span
                className="flex-none text-ink-400 transition-transform group-open:rotate-45"
                aria-hidden="true"
              >
                +
              </span>
            </summary>
            <p className="mt-2.5 text-sm leading-relaxed text-ink-300">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
