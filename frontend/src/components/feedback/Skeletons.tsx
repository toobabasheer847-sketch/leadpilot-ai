export function TableSkeleton() {
  return (
    <div className="skeleton table-skeleton" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => <span key={index} />)}
    </div>
  );
}

export function CompanySkeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <span /><span /><span /><span />
    </div>
  );
}

export function EvidenceSkeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <span /><span /><span />
    </div>
  );
}

export function DecisionMakerSkeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <span /><span /><span />
    </div>
  );
}

export function VerificationSkeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <span /><span /><span /><span />
    </div>
  );
}
