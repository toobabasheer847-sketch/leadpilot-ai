export function LeadScoreBadge({ score }: { score: { value: number; band: string | null } | null }) {
  if (!score) return <span>Not available</span>;
  return <span className="badge">{score.value}{score.band ? ` · ${score.band}` : ''}</span>;
}
