import { memo, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const inks = [
  ["#345d75", "#af644e"], // Prussian blue and madder
  ["#426a57", "#ab7640"], // fern and ochre
  ["#5e567c", "#957459"], // mulberry and umber
  ["#365f63", "#8f6173"], // teal and heather
];

export function randomPrintSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

function randomSequence(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

// Individual engraved shapes are defined once and stamped at different angles and scales.
function Specimens({ id }: { id: string }) {
  return <defs>
    <g id={id + "leaf"}>
      <path fill="var(--plate-leaf)" d="M0 0C5-14 22-25 41-24C36-9 18 0 0 0Z" />
      <path strokeWidth=".85" d="M1 0Q22-12 39-23M9-4l3-8m4 4 5-11m2 7 6-10M14-7l9-1m0-5 9-1" />
    </g>
    <g id={id + "fern"}>
      <path d="M0 0Q14-11 42-27" />
      {Array.from({ length: 8 }, (_, i) => {
        const x = 3 + 4.7 * i, y = -x * .68, h = 11 * Math.sin((i + 1) / 10 * Math.PI);
        return <path key={i} fill="var(--plate-leaf)" strokeWidth=".8"
          d={`M${x} ${y}q-2 ${-h * .65} 4 ${-h}q2 ${h * .54} -4 ${h} m0 0q7 2 ${h + 1} -5q-6 -2 ${-h - 1} 5`} />;
      })}
    </g>
    <g id={id + "poppy"}>
      {Array.from({ length: 5 }, (_, i) => <g key={i} transform={`rotate(${i * 72})`}>
        <path fill="var(--plate-petal)" d="M0 1C-6-3-19-11-17-18Q-17-22-12-22Q-10-28-4-25Q1-30 5-26Q11-27 13-20C17-12 5-3 0 1Z" />
        <path strokeWidth=".65" d="M-2-4Q-10-15-11-20M0-6Q-4-18-4-23M2-6Q5-16 7-21M4-5Q10-13 11-17" />
      </g>)}
      <circle r="5" fill="currentColor" /><circle r="2.2" fill="var(--plate-ground)" />
    </g>
    <g id={id + "umbel"}>
      {Array.from({ length: 9 }, (_, i) => <g key={i} transform={`rotate(${(i - 4) * 13})`}>
        <path d="M0 0Q-1-14 0-27m0 0-4-5m4 5 4-5m-4 5v-8" />
        <path fill="var(--plate-petal)" d="M-6-33a2.2 2.2 0 1 0 4 0a2.2 2.2 0 1 0-4 0M-2-36a2 2 0 1 0 4 0a2 2 0 1 0-4 0M2-33a2 2 0 1 0 4 0a2 2 0 1 0-4 0" />
      </g>)}
    </g>
    <g id={id + "pod"}>
      <path fill="var(--plate-leaf)" d="M0 0C-10-5-9-15-4-20L5-20C10-12 9-5 0 0Z" />
      <path d="M-5-21Q0-24 6-21L4-18H-3ZM0-1Q-4-12-2-18M2-2Q6-12 3-17" />
    </g>
    <g id={id + "bells"}>
      <path d="M0 0Q-3-28 8-57" />
      {[0, 1, 2, 3, 4].map(i => <g key={i} transform={`translate(${i*.9} ${-9-i*9}) scale(${i%2 ? -1 : 1} 1) scale(${1-i*.105})`}>
        <path d="M0 0Q7-13 12-7" />
        <path fill="var(--plate-petal)" d="M12-8C18-8 18-1 23 5Q22 9 19 6Q17 12 15 8Q11 12 10 8C11 1 6-4 12-8Z" />
        <path strokeWidth=".65" d="M13-6Q15-5 17 6M15-5Q19 1 19 5" />
      </g>)}
    </g>
    <g id={id + "moth"}>
      {[-1, 1].map(side => <g key={side} transform={`scale(${side} 1)`}>
        <path fill="var(--plate-petal)" d="M0 1Q13-20 35-23Q33-8 21 3Q25 12 15 18Q6 14 0 1Z" />
        <path strokeWidth=".8" d="M2 1 30-19M4 2Q17-9 27-8M3 2Q14-2 21 3M3 3 17 13M2 3 12 15M27-19Q28-11 21-4" />
        <ellipse cx="15" cy="9" rx="2.6" ry="2" fill="var(--plate-ground)" />
        <path d="M0-3Q3-10 8-11" />
      </g>)}
      <ellipse cx="0" cy="3" rx="1.6" ry="7.5" fill="currentColor" />
    </g>
  </defs>;
}

type Point = { x: number; y: number };

function Stem({ base, tip, bend, size, species, phase, id }: {
  base: Point; tip: Point; bend: number; size: number; species: string; phase: number; id: string;
}) {
  const dx = tip.x - base.x, dy = tip.y - base.y;
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  const control = { x: (base.x + tip.x) / 2 - dy / length * bend, y: (base.y + tip.y) / 2 + dx / length * bend };
  const stamp = (type: string, x: number, y: number, angle: number, scale: number, side = 1) => (
    <use href={"#" + id + type} transform={`translate(${x} ${y}) rotate(${angle}) scale(${side * scale} ${scale})`} />
  );
  const nodes = Math.max(5, Math.min(12, Math.round(length / 46)));
  return <g>
    <path strokeWidth={size * 1.6} d={`M${base.x} ${base.y}Q${control.x} ${control.y} ${tip.x} ${tip.y}`} />
    {Array.from({ length: nodes }, (_, i) => {
      const t = (i + .8) / (nodes + 1), u = 1 - t;
      const x = u*u*base.x + 2*u*t*control.x + t*t*tip.x;
      const y = u*u*base.y + 2*u*t*control.y + t*t*tip.y;
      const angle = Math.atan2(u*(control.y-base.y) + t*(tip.y-control.y), u*(control.x-base.x) + t*(tip.x-control.x)) * 180 / Math.PI + 90;
      const side = i % 2 ? 1 : -1;
      const scale = size * (.48 + .56 * Math.sin(t * Math.PI)) * (1 + .15*Math.sin(i+phase));
      return <g key={i}>
        {stamp(species === "fern" ? "fern" : "leaf", x, y, angle - side * (8 + t*22), scale, side)}
        {i % 4 === 2 && species !== "fern" && <g transform={`translate(${x} ${y}) rotate(${angle}) scale(${-side*scale} ${scale})`}>
          <path d="M0 0Q22-9 25-37" />{stamp(species === "umbel" ? "umbel" : "pod",25,-37,14,.56)}
        </g>}
      </g>;
    })}
    {species !== "fern" && stamp(species, tip.x, tip.y, Math.atan2(tip.y-control.y, tip.x-control.x)*180/Math.PI+90, size)}
  </g>;
}

export const HomePattern = memo(function HomePattern({ seed }: { seed: number }) {
  const host = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(1280);
  const id = useId();
  useLayoutEffect(() => {
    const svg = host.current;
    if (!svg) return;
    const measure = () => {
      if (svg.clientHeight) setWidth(Math.max(1, Math.round(760 * svg.clientWidth / svg.clientHeight)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const rand = randomSequence(seed);
  const palette = inks[Math.floor(rand()*inks.length)]!;
  const mirrored = rand() < .5;
  const flowers = ["poppy", "umbel", "bells"] as const;
  const family = Math.floor(rand() * flowers.length);
  const dominant = flowers[family]!;
  const secondary = flowers[(family + 1) % flowers.length]!;
  const stems = [];
  // Tall plants and low undergrowth share a ground line, with open air behind the shelf.
  for (let i = 0; i < 24; i++) {
    const left = i < 14;
    const spread = rand();
    const edge = left ? spread * .37 : 1 - spread * .34;
    const x = edge * width;
    const height = (left ? 680 : 540) * (1 - spread * .76) * (.6 + rand() * .52);
    const lean = (left ? 1 : -1) * (rand() - .48) * Math.min(200, width * .16);
    const pick = rand();
    stems.push(<Stem key={i} base={{ x: x - lean, y: 792 + rand()*60 }} tip={{ x, y: 770-height }}
      bend={(rand()-.5)*130} size={.62 + rand()*.57}
      species={pick < .32 ? "fern" : pick < .50 ? "pod" : pick < .78 ? dominant : secondary}
      phase={rand()*6} id={id} />);
  }
  // A climbing spray traverses the upper field. Its direction opposes the tallest clump below.
  for (let i=0; i<4; i++) {
    stems.push(<Stem key={24+i} base={{ x:width+45, y:95 + i*35 }}
      tip={{ x:width*(.38 + i*.11 + rand()*.055), y:45 + rand()*90 }}
      bend={-70-rand()*100} size={.58 + rand()*.24} species={i===0 ? dominant : "fern"} phase={i} id={id} />);
  }
  return <div className="lg-home-pattern" aria-hidden="true" style={{
    "--print-ink": palette[0], "--print-accent": palette[1],
  } as CSSProperties}>
    <svg ref={host} viewBox={`0 0 ${width} 760`} preserveAspectRatio="none" fill="none" stroke="currentColor" strokeWidth="1.15">
      <Specimens id={id} />
      <g transform={mirrored ? `translate(${width} 0) scale(-1 1)` : undefined}>
        {stems}
        <use href={"#" + id + "moth"} transform={`translate(${width * (.15 + rand() * .16)} ${120 + rand() * 90}) rotate(${rand() * 50 - 35}) scale(.83)`} />
      </g>
    </svg>
  </div>;
});
