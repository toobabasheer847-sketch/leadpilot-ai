import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { createResearch, getClassification, getCompany, getDecisionMakers, getEvidence, getLead, getResearch, getResearchHistory, getVerification } from '../api/endpoints';
import { ApiError } from '../api/client';
import { ClassificationEvidence } from '../components/company/ClassificationEvidence';
import { CompanyOverview } from '../components/company/CompanyOverview';
import { ConflictPanel } from '../components/company/ConflictPanel';
import { ContactCard } from '../components/company/ContactCard';
import { DecisionMakerCard } from '../components/company/DecisionMakerCard';
import { EvidencePanel } from '../components/company/EvidencePanel';
import { evidenceTotal, InvestorCard } from '../components/company/InvestorCard';
import { ResearchHistory } from '../components/company/ResearchHistory';
import { SocialLinks } from '../components/company/SocialLinks';
import { VerificationCard } from '../components/company/VerificationCard';
import { ConfirmDialog } from '../components/feedback/ConfirmDialog';
import { MotionPanel } from '../components/feedback/MotionPanel';
import { CompanySkeleton, DecisionMakerSkeleton, EvidenceSkeleton, VerificationSkeleton } from '../components/feedback/Skeletons';
import { EmptyState, ErrorState } from '../components/feedback/States';
import { LeadStatusBadge } from '../components/leads/LeadStatusBadge';
import { useToasts } from '../feedback/toasts';
import { toCompanyOverview, verificationCards } from '../lib/company-view';
import { mergeEvidence } from '../lib/evidence';
import { collectSocialLinks } from '../lib/social';
import type { ClassificationRecord, CompanyProfile, DecisionMaker, EvidenceItem, LeadRecord, ResearchExecution, VerificationSummary } from '../types/api';

type AsyncState<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

function message(reason: unknown, fallback: string) {
  return reason instanceof ApiError ? reason.message : fallback;
}

function companyStatus(summary: VerificationSummary | null, fieldName: string): string | null {
  return summary?.fields.find((field) => field.fieldName === fieldName && !field.contactId)?.status ?? null;
}

export function LeadDetailPage() {
  const { companyId = '' } = useParams();
  const { notify } = useToasts();
  const [lead, setLead] = useState<AsyncState<LeadRecord>>({ status: 'loading' });
  const [company, setCompany] = useState<AsyncState<CompanyProfile>>({ status: 'loading' });
  const [people, setPeople] = useState<AsyncState<DecisionMaker[]>>({ status: 'loading' });
  const [verification, setVerification] = useState<AsyncState<VerificationSummary>>({ status: 'loading' });
  const [classification, setClassification] = useState<AsyncState<ClassificationRecord | null>>({ status: 'loading' });
  const [research, setResearch] = useState<AsyncState<ResearchExecution[]>>({ status: 'loading' });
  const [evidence, setEvidence] = useState<AsyncState<EvidenceItem[]>>({ status: 'loading' });
  const [confirmResearch, setConfirmResearch] = useState(false);
  const [researchBusy, setResearchBusy] = useState(false);
  const [activeResearch, setActiveResearch] = useState<{ id: string; status: string; pagesProcessed: number | null; fieldsExtracted: number | null } | null>(null);
  const companyRef = useRef(companyId);
  const mounted = useRef(true);
  companyRef.current = companyId;

  function loadResearch(id: string) {
    setResearch({ status: 'loading' });
    getResearchHistory(id).then((rows) => {
      if (!mounted.current || companyRef.current !== id) return;
      setResearch(Array.isArray(rows) ? { status: 'ready', data: rows } : { status: 'error', message: 'Unable to read the research history.' });
    }).catch((reason: unknown) => {
      if (!mounted.current || companyRef.current !== id) return;
      setResearch({ status: 'error', message: message(reason, 'Unable to load research history.') });
    });
  }

  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (!companyId) return undefined;
    let active = true;
    setLead({ status: 'loading' });
    setCompany({ status: 'loading' });
    setPeople({ status: 'loading' });
    setVerification({ status: 'loading' });
    setClassification({ status: 'loading' });
    setEvidence({ status: 'loading' });
    setActiveResearch(null);
    getLead(companyId).then((data) => { if (active) setLead({ status: 'ready', data }); }).catch((reason: unknown) => { if (active) setLead({ status: 'error', message: message(reason, 'Unable to load this company.') }); });
    getCompany(companyId).then((data) => { if (active) setCompany({ status: 'ready', data }); }).catch((reason: unknown) => { if (active) setCompany({ status: 'error', message: message(reason, 'Unable to load the company profile.') }); });
    getDecisionMakers(companyId).then((data) => { if (active) setPeople(Array.isArray(data) ? { status: 'ready', data } : { status: 'error', message: 'Unable to read decision makers.' }); }).catch((reason: unknown) => { if (active) setPeople({ status: 'error', message: message(reason, 'Unable to load decision makers.') }); });
    getVerification(companyId).then((data) => { if (active) setVerification({ status: 'ready', data }); }).catch((reason: unknown) => { if (active) setVerification({ status: 'error', message: message(reason, 'Unable to load verification.') }); });
    getClassification(companyId).then((data) => { if (active) setClassification({ status: 'ready', data }); }).catch((reason: unknown) => { if (active) setClassification({ status: 'error', message: message(reason, 'Unable to load classification.') }); });
    getEvidence(companyId).then((data) => { if (active) setEvidence(Array.isArray(data) ? { status: 'ready', data } : { status: 'error', message: 'Unable to read evidence.' }); }).catch((reason: unknown) => { if (active) setEvidence({ status: 'error', message: message(reason, 'Unable to load evidence.') }); });
    loadResearch(companyId);
    return () => { active = false; };
  }, [companyId]);

  useEffect(() => {
    if (!companyId || !activeResearch || (activeResearch.status !== 'QUEUED' && activeResearch.status !== 'RUNNING')) return undefined;
    let active = true;
    const timer = window.setInterval(() => {
      getResearch(companyId, activeResearch.id).then((row) => {
        if (!active) return;
        setActiveResearch({ id: row.id, status: row.status, pagesProcessed: row.pagesProcessed, fieldsExtracted: row.fieldsExtracted });
        if (row.status !== 'QUEUED' && row.status !== 'RUNNING') loadResearch(companyId);
      }).catch(() => undefined);
    }, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeResearch, companyId]);

  async function startResearch() {
    if (!companyId) return;
    setResearchBusy(true);
    try {
      const result = await createResearch(companyId);
      setActiveResearch({ id: result.researchExecutionId, status: result.status, pagesProcessed: null, fieldsExtracted: null });
      notify('success', `Research status: ${result.status}`);
      setConfirmResearch(false);
      loadResearch(companyId);
    } catch (reason) {
      notify('error', message(reason, 'Unable to start research.'));
    } finally {
      setResearchBusy(false);
    }
  }

  if (!companyId) return <ErrorState message="The requested record was not found." />;
  if (lead.status === 'loading') return <CompanySkeleton />;
  if (lead.status === 'error') {
    return (
      <section className="stack">
        <ErrorState message={lead.message} />
        <Link to="/leads">Back to leads</Link>
      </section>
    );
  }

  const profile = company.status === 'ready' ? company.data : null;
  const overview = toCompanyOverview(lead.data, profile);
  const summary = verification.status === 'ready' ? verification.data : null;
  const storedEvidence = mergeEvidence([lead.data.evidence, evidence.status === 'ready' ? evidence.data : []]);
  const socials = collectSocialLinks({ rows: lead.data.socialProfiles, map: profile?.socialProfiles });
  const researchAction = <button type="button" onClick={() => setConfirmResearch(true)}>Research Again</button>;

  return (
    <section className="stack">
      <p><Link to="/leads">Back to leads</Link></p>
      <MotionPanel>
        <h2>Company overview</h2>
        {company.status === 'error' ? <ErrorState message={company.message} /> : null}
        <CompanyOverview company={overview} />
      </MotionPanel>
      <MotionPanel>
        <h2>Investor information</h2>
        {classification.status === 'loading' ? <CompanySkeleton /> : null}
        {classification.status === 'error' ? <ErrorState message={classification.message} /> : null}
        {classification.status === 'ready' ? <InvestorCard classification={classification.data} lead={lead.data} evidenceCount={evidenceTotal(summary, lead.data.evidence.length)} /> : null}
      </MotionPanel>
      <MotionPanel>
        <h2>Classification evidence</h2>
        {classification.status === 'loading' ? <EvidenceSkeleton /> : null}
        {classification.status === 'error' ? <ErrorState message={classification.message} /> : null}
        {classification.status === 'ready' ? (
          <ClassificationEvidence references={[...(classification.data?.positiveEvidence ?? []), ...(classification.data?.negativeEvidence ?? [])]} evidence={storedEvidence} />
        ) : null}
      </MotionPanel>
      <MotionPanel>
        <h2>Decision makers</h2>
        {people.status === 'loading' ? <DecisionMakerSkeleton /> : null}
        {people.status === 'error' ? <ErrorState message={people.message} /> : null}
        {people.status === 'ready' && people.data.length === 0 ? <EmptyState title="No decision makers found" detail="People appear here when contact discovery stores a name and title." action={researchAction} /> : null}
        {people.status === 'ready' ? <div className="detail-grid">{people.data.map((person) => <DecisionMakerCard key={person.id} person={person} />)}</div> : null}
      </MotionPanel>
      <MotionPanel>
        <h2>Contact information</h2>
        {verification.status === 'loading' ? <VerificationSkeleton /> : null}
        {verification.status === 'error' ? <ErrorState message={verification.message} /> : null}
        {verification.status !== 'loading' ? <ContactCard email={overview.email} emailStatus={companyStatus(summary, 'email')} phone={overview.phone} phoneStatus={companyStatus(summary, 'phone')} /> : null}
      </MotionPanel>
      <MotionPanel>
        <h2>Social profiles</h2>
        <SocialLinks links={socials} />
      </MotionPanel>
      <MotionPanel>
        <h2>Verification</h2>
        {verification.status === 'loading' ? <VerificationSkeleton /> : null}
        {verification.status === 'error' ? <ErrorState message={verification.message} /> : null}
        {verification.status === 'ready' && verification.data.fields.length === 0 ? <EmptyState title="No verification data available" detail="Field verification appears after the verification job stores a result." /> : null}
        {verification.status === 'ready' && verification.data.fields.length > 0 ? (
          <div className="detail-grid">
            {verificationCards(verification.data.fields, storedEvidence).map((card) => (
              <VerificationCard key={card.key} label={card.label} value={card.value} status={card.status} evidenceCount={card.evidenceCount} verifiedAt={card.verifiedAt} />
            ))}
          </div>
        ) : null}
      </MotionPanel>
      <MotionPanel>
        <h2>Evidence</h2>
        {evidence.status === 'loading' && storedEvidence.length === 0 ? <EvidenceSkeleton /> : null}
        {evidence.status === 'error' && storedEvidence.length === 0 ? <ErrorState message={evidence.message} /> : null}
        {storedEvidence.length > 0 || evidence.status === 'ready' ? <EvidencePanel evidence={storedEvidence} /> : null}
      </MotionPanel>
      <MotionPanel>
        <h2>Conflicts</h2>
        {verification.status === 'loading' ? <VerificationSkeleton /> : null}
        {verification.status === 'error' ? <ErrorState message={verification.message} /> : null}
        {verification.status === 'ready' ? <ConflictPanel conflicts={verification.data.conflicts} /> : null}
      </MotionPanel>
      <MotionPanel>
        <h2>Research history</h2>
        {activeResearch ? (
          <p>Latest response <LeadStatusBadge status={activeResearch.status} /> · Pages processed {activeResearch.pagesProcessed ?? 'Not available'} · Fields extracted {activeResearch.fieldsExtracted ?? 'Not available'}</p>
        ) : null}
        {research.status === 'loading' ? <CompanySkeleton /> : null}
        {research.status === 'error' ? <ErrorState message={research.message} /> : null}
        {research.status === 'ready' ? <ResearchHistory rows={research.data} action={researchAction} /> : null}
      </MotionPanel>
      {confirmResearch ? (
        <ConfirmDialog title="Research again" message="Start another research run for this company?" confirmLabel="Start research" busy={researchBusy} onConfirm={() => void startResearch()} onCancel={() => setConfirmResearch(false)} />
      ) : null}
    </section>
  );
}
