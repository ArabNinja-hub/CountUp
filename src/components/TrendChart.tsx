import React, { useRef, useState, useEffect, useMemo } from 'react';

export interface TrendPoint {
  label: string;
  sales: number;
  profit: number;
}

interface TrendChartProps {
  data: TrendPoint[];
  height?: number;
}

/** Round a value up to a clean axis maximum (1, 2, 5 × 10^n). */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const frac = value / base;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * base;
}

export const TrendChart: React.FC<TrendChartProps> = ({ data, height = 220 }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(280, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padL = 10;
  const padR = 10;
  const padT = 14;
  const padB = 26;
  const innerW = Math.max(1, width - padL - padR);
  const innerH = Math.max(1, height - padT - padB);
  const n = data.length;

  const { salesPath, profitPath, areaPath, points, yTicks, labelStep } = useMemo(() => {
    const maxVal = Math.max(1, ...data.map((d) => Math.max(d.sales, d.profit)));
    const niceMax = niceCeil(maxVal);
    const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
    const y = (v: number) => padT + innerH - (v / niceMax) * innerH;

    const pts = data.map((d, i) => ({
      x: x(i),
      ySales: y(d.sales),
      yProfit: y(d.profit),
      d,
    }));

    const sp = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.ySales.toFixed(1)}`)
      .join(' ');
    const pp = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.yProfit.toFixed(1)}`)
      .join(' ');
    const last = pts[pts.length - 1];
    const first = pts[0];
    const ap =
      pts.length > 0
        ? `${sp} L ${last.x.toFixed(1)} ${(padT + innerH).toFixed(1)} L ${first.x.toFixed(1)} ${(padT + innerH).toFixed(1)} Z`
        : '';

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
      v: t * niceMax,
      y: padT + innerH - t * innerH,
    }));

    const step = Math.max(1, Math.ceil(n / 6));

    return {
      salesPath: sp,
      profitPath: pp,
      areaPath: ap,
      points: pts,
      yTicks: ticks,
      labelStep: step,
    };
  }, [data, n, innerW, innerH]);

  const active = hover != null && points[hover] ? points[hover] : null;

  return (
    <div ref={containerRef} className="relative w-full" style={{ height }}>
      {n === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
          No sales recorded in this period yet.
        </div>
      ) : (
        <>
          <svg
            ref={svgRef}
            width="100%"
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="block"
            role="img"
            aria-label="Sales and profit trend"
          >
            <defs>
              <linearGradient id="trendArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#059669" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#059669" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Horizontal gridlines */}
            {yTicks.map((t, i) => (
              <g key={i}>
                <line
                  x1={padL}
                  x2={width - padR}
                  y1={t.y}
                  y2={t.y}
                  stroke="#e2e8f0"
                  strokeWidth={1}
                  strokeDasharray={i === 0 ? '0' : '3 3'}
                />
                <text x={padL + 2} y={t.y - 3} className="fill-slate-400" fontSize={9}>
                  K{' '}
                  {t.v >= 1000
                    ? `${(t.v / 1000).toFixed(t.v % 1000 === 0 ? 0 : 1)}k`
                    : Math.round(t.v)}
                </text>
              </g>
            ))}

            {/* Sales area + line */}
            <path d={areaPath} fill="url(#trendArea)" />
            <path
              d={salesPath}
              fill="none"
              stroke="#059669"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {/* Profit line */}
            <path
              d={profitPath}
              fill="none"
              stroke="#d97706"
              strokeWidth={2}
              strokeDasharray="5 4"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* X labels */}
            {points.map((p, i) =>
              i % labelStep === 0 || i === n - 1 ? (
                <text
                  key={i}
                  x={p.x}
                  y={height - 8}
                  textAnchor="middle"
                  className="fill-slate-400"
                  fontSize={9}
                >
                  {p.d.label}
                </text>
              ) : null
            )}

            {/* Hover guide */}
            {active && (
              <g>
                <line
                  x1={active.x}
                  x2={active.x}
                  y1={padT}
                  y2={padT + innerH}
                  stroke="#94a3b8"
                  strokeWidth={1}
                />
                <circle
                  cx={active.x}
                  cy={active.ySales}
                  r={3.5}
                  fill="#059669"
                  stroke="#fff"
                  strokeWidth={1.5}
                />
                <circle
                  cx={active.x}
                  cy={active.yProfit}
                  r={3.5}
                  fill="#d97706"
                  stroke="#fff"
                  strokeWidth={1.5}
                />
              </g>
            )}

            {/* Interaction overlay */}
            <rect
              x={0}
              y={0}
              width={width}
              height={height}
              fill="transparent"
              onMouseMove={(e) => {
                const rect = svgRef.current?.getBoundingClientRect();
                if (!rect || n <= 1) return;
                const xRel = e.clientX - rect.left;
                const frac = (xRel - padL) / innerW;
                const idx = Math.min(n - 1, Math.max(0, Math.round(frac * (n - 1))));
                setHover(idx);
              }}
              onMouseLeave={() => setHover(null)}
            />
          </svg>

          {active && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-xl bg-slate-900/95 text-white px-3 py-2 text-[11px] shadow-lg"
              style={{ left: active.x, top: Math.min(active.ySales, active.yProfit) - 8 }}
            >
              <p className="font-bold mb-1">{active.d.label}</p>
              <p className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                Sales: K {active.d.sales.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                Profit: K {active.d.profit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
};
