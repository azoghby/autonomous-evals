type Props = { title: string; suggestions: readonly string[]; disabled: boolean; onPick: (text: string) => void };

export function EmptyState({ suggestions, disabled, onPick }: Props) {
  return (
    <div className="ec-empty">
      <h2 className="ec-empty-title">What do you want to know?</h2>
      <p className="ec-text">Answers come only from this eval&apos;s transcripts, checks and data. Ask why a trial failed, compare runs, or add a scenario and re-run it. Anything that costs money shows an estimate and waits for you to confirm.</p>
      {suggestions.length > 0 ? (
        <ul className="ec-suggest" aria-label="Suggested questions">
          {suggestions.map((s) => (
            <li key={s}><button type="button" className="ec-suggest-btn" disabled={disabled} onClick={() => onPick(s)}>{s}</button></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
