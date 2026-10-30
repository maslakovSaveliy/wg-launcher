// The `needs_recovery` banner (save-transfer.md section 6, "Failed rollback"): the game is refused until a rollback
// verifies; "Retry recovery" runs it again. The backup is never deleted, so the text can say it is kept.

export function RecoveryBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="recovery" role="alert">
      <p>
        The game's saves need recovery before it can start: putting back the saves from before an
        import or delete did not finish. The backup of those saves is kept.
      </p>
      <button type="button" onClick={onRetry}>
        Retry recovery
      </button>
    </div>
  );
}
