type Point = { kwh?: number | null; date?: string } | number;

type Props = {
  series?: Point[] | null;
  width?: number;
  height?: number;
  className?: string;
};

function vals(series?: Point[] | null): number[] {
  if (!series?.length) return [];
  return series
    .map((p) => (typeof p === "number" ? p : Number(p?.kwh ?? 0)))
    .filter((n) => Number.isFinite(n));
}

/** Compact production sparkline for array/inverter cards and table rows. */
export function Sparkline({ series, width = 88, height = 28, className = "" }: Props) {
  const v = vals(series);
  if (v.length < 2) {
    return (
      <div
        className={`inline-flex items-center text-[10px] font-semibold text-muted ${className}`}
        style={{ width, height }}
      >
        ···
      </div>
    );
  }
  const max = Math.max(...v, 0.001);
  const min = Math.min(...v, 0);
  const span = Math.max(max - min, max * 0.08, 0.001);
  const step = width / (v.length - 1);
  const pts = v
    .map((n, i) => {
      const x = i * step;
      const y = height - 2 - ((n - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = v[v.length - 1];
  const first = v[0];
  const up = last >= first;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden
    >
      <polyline
        fill="none"
        stroke={up ? "#2196F3" : "#64748b"}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
      />
      <circle
        cx={width}
        cy={height - 2 - ((last - min) / span) * (height - 4)}
        r="2.5"
        fill={up ? "#1976D2" : "#64748b"}
      />
    </svg>
  );
}
