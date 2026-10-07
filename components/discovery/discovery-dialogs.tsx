'use client';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { communitySources } from '@/lib/social.mjs';
import type { SourceReport } from './use-discovery-results';

/** Neighbourhood picker opened from the Filters button. */
export function AreaFilterDialog({
  open,
  onOpenChange,
  area,
  areas,
  onAreaChange,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  area: string;
  areas: string[];
  onAreaChange: (area: string) => void;
  onReset: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Make it your kind of outing</DialogTitle>
        <DialogDescription>Choose an area to explore.</DialogDescription>
        <label htmlFor="area">Neighbourhood</label>
        <select id="area" value={area} onChange={(event) => onAreaChange(event.target.value)}>
          {['All neighbourhoods', ...areas].map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <Button onClick={() => onOpenChange(false)}>Show discoveries</Button>
        <Button
          variant="ghost"
          onClick={() => {
            onReset();
            onOpenChange(false);
          }}
        >
          Reset filters
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/** Where listings come from, with each source's freshness. */
export function SourcesDialog({
  open,
  onOpenChange,
  reports,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reports: SourceReport[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Connected to the city</DialogTitle>
        <DialogDescription>
          Our first sources. Listings link back to the people who know them best.
        </DialogDescription>
        {reports.map((report) => (
          <div className="source-row" key={report.id}>
            <a href={report.url} target="_blank" rel="noreferrer">
              <strong>{report.name}</strong>
              <ExternalLink size={14} />
            </a>
            <p>
              {report.count} collected listings ·{' '}
              {report.status === 'ok'
                ? 'Last checked ' + new Date(report.checkedAt).toLocaleDateString('en-CA')
                : 'Update unavailable; using previous listings'}
            </p>
          </div>
        ))}
        {communitySources.map((source) => (
          <div className="source-row" key={source.id}>
            <a href={source.url} target="_blank" rel="noreferrer">
              <strong>{source.name}</strong>
              <ExternalLink size={14} />
            </a>
            <p>{source.note}</p>
            <span className="manual-label">
              {source.mode === 'browser'
                ? 'Daily browser collector'
                : 'Added by post link · No automatic feed'}
            </span>
          </div>
        ))}
        <p className="source-note">
          Collection is growing. Some calendars show only a limited date range. Missing details are
          left unconfirmed.
        </p>
      </DialogContent>
    </Dialog>
  );
}
