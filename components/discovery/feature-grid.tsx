'use client';
import { ArrowUpRight } from 'lucide-react';
import { FORKS_IMAGE, LEAF_IMAGE } from './listing-format';

/** The two large photo tiles on the unfiltered Explore tab. */
export function FeatureGrid({
  onShowForks,
  onShowOutdoors,
}: {
  onShowForks: () => void;
  onShowOutdoors: () => void;
}) {
  return (
    <section className="feature-grid">
      <button className="feature-main" onClick={onShowForks}>
        <img src={FORKS_IMAGE} alt="The Forks at the meeting of Winnipeg’s rivers" />
        <div className="image-shade" />
        <div className="feature-copy">
          <span className="photo-label">THE LOCAL FAVOURITE</span>
          <h2>
            Meet you at
            <br />
            The Forks.
          </h2>
          <p>A meeting place. A market. A whole afternoon.</p>
          <span className="feature-link">
            Find your way there <ArrowUpRight size={20} />
          </span>
        </div>
        <span className="photo-credit">Photo: Travel Manitoba</span>
      </button>
      <button className="feature-side" onClick={onShowOutdoors}>
        <div className="side-image">
          <img src={LEAF_IMAGE} alt="The Leaf conservatory and gardens at Assiniboine Park" />
          <span className="photo-label">A BREATH OF FRESH AIR</span>
        </div>
        <span className="side-photo-credit">Photo: Assiniboine Park Conservancy</span>
        <div className="side-copy">
          <div>
            <span className="eyebrow">A LITTLE NATURE GOES A LONG WAY</span>
            <h2>Take the scenic route.</h2>
            <p>Gardens, green spaces, and room to wander.</p>
          </div>
          <span className="round-arrow">
            <ArrowUpRight />
          </span>
        </div>
      </button>
    </section>
  );
}
