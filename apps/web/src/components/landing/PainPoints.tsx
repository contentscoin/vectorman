const CASES = [
  {
    title: 'The client logo',
    body: 'They sent a 200-pixel PNG and nobody can find the original vector. Image Trace hands back a tangle of anchor points that takes longer to clean up than redrawing the mark from scratch.',
  },
  {
    title: 'The vendor rejection',
    body: 'The print shop asked for “a vector file”. You saved the JPG inside a PDF, they rejected it again, and now an hourly art fee stands between you and your order.',
  },
  {
    title: 'The AI design',
    body: 'ChatGPT made you a great logo. As pixels. Ask it for an SVG and you get the same pixels in an SVG wrapper, which falls apart the moment you try to edit it.',
  },
];

export function PainPoints() {
  return (
    <section className="section py-20 sm:py-28">
      <div className="max-w-2xl">
        <p className="eyebrow">Sound familiar?</p>
        <h2 className="heading-lg mt-3 text-balance">
          The file looked fine — until you tried to use it.
        </h2>
      </div>

      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {CASES.map((item) => (
          <article key={item.title} className="card">
            <h3 className="text-base font-semibold text-ink-100">{item.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-300">{item.body}</p>
          </article>
        ))}
      </div>

      <p className="mt-8 max-w-2xl text-sm text-ink-400">
        Different projects, same wall: the file was never really a vector, or it is one that cannot
        survive editing.
      </p>
    </section>
  );
}
