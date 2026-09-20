import { useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';

export interface TrendPoint {
  run: number;
  score: number;
  finishedAt: string | null;
}

interface TooltipPayload {
  payload?: TrendPoint;
}

/** One value leads, the label follows. Text uses text tokens, only the key carries the colour. */
function TrendTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 shadow-pop">
      <div className="flex items-center gap-2">
        <span className="h-0.5 w-3 rounded-full bg-accent" aria-hidden />
        <span className="tabular text-sm font-semibold text-fg">{point.score}</span>
        <span className="text-xs text-muted">health score</span>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        Run #{point.run}
        {point.finishedAt ? ` · ${formatDateTime(point.finishedAt)}` : ''}
      </p>
    </div>
  );
}

/** The score of the last scans of a site. A single series, so no legend: the title names it. */
export function ScoreTrend({ points, currentRun }: { points: TrendPoint[]; currentRun: number }) {
  const gradientId = useId().replace(/:/g, '');
  if (points.length < 2) return null;
  const last = points[points.length - 1] as TrendPoint;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Health score over time</CardTitle>
          <CardDescription>The last {points.length} completed scans of this site.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div
          className="h-40 w-full"
          role="img"
          aria-label={`Health score across ${points.length} scans, most recent ${last.score} out of 100`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 12, right: 16, bottom: 0, left: -8 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.14} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
              <XAxis
                dataKey="run"
                tickFormatter={(run: number) => `#${run}`}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--text-subtle)', fontSize: 12 }}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 50, 100]}
                tickLine={false}
                axisLine={false}
                width={40}
                tick={{ fill: 'var(--text-subtle)', fontSize: 12 }}
              />
              <Tooltip
                content={<TrendTooltip />}
                cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
              />
              <Area
                type="monotone"
                dataKey="score"
                stroke="var(--accent)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill={`url(#${gradientId})`}
                isAnimationActive={false}
                dot={(props: {
                  cx?: number;
                  cy?: number;
                  index?: number;
                  payload?: TrendPoint;
                }) => {
                  const { cx, cy, index, payload } = props;
                  const key = `dot-${payload?.run ?? index}`;
                  if (cx === undefined || cy === undefined) return <g key={key} />;
                  // Only the end point is marked: 8px across with a 2px ring in the surface colour.
                  const isEnd = index === points.length - 1;
                  return isEnd ? (
                    <circle
                      key={key}
                      cx={cx}
                      cy={cy}
                      r={4}
                      fill="var(--accent)"
                      stroke="var(--surface)"
                      strokeWidth={2}
                    />
                  ) : (
                    <g key={key} />
                  );
                }}
                activeDot={{
                  r: 4,
                  fill: 'var(--accent)',
                  stroke: 'var(--surface)',
                  strokeWidth: 2,
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer text-muted hover:text-fg">View as table</summary>
          <table className="mt-2 w-full max-w-md text-left">
            <thead className="text-xs text-subtle">
              <tr>
                <th className="py-1 pr-4 font-medium">Run</th>
                <th className="py-1 pr-4 font-medium">Finished</th>
                <th className="py-1 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((point) => (
                <tr key={point.run} className="border-t border-border">
                  <td className="py-1 pr-4">
                    #{point.run}
                    {point.run === currentRun ? ' (this scan)' : ''}
                  </td>
                  <td className="py-1 pr-4 text-muted">{formatDateTime(point.finishedAt)}</td>
                  <td className="tabular py-1 text-right font-medium">{point.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </CardContent>
    </Card>
  );
}
