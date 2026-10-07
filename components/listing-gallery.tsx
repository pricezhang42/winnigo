'use client';
import { useEffect, useState } from 'react';
import { Expand, Images, ExternalLink } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
  type CarouselApi,
} from '@/components/ui/carousel';
import { Button } from '@/components/ui/button';

/** Cover photo that opens a full-size carousel with thumbnails. Duplicate URLs are dropped. */
export default function ListingGallery({
  images,
  title,
  sourceUrl,
}: {
  images: string[];
  title: string;
  sourceUrl: string;
}) {
  const photos = [...new Set(images.filter(Boolean))];
  const [open, setOpen] = useState(false);
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(0);

  // Track the carousel's selected photo for the counter and thumbnails.
  useEffect(() => {
    if (!api) return;
    const select = () => setCurrent(api.selectedScrollSnap());
    select();
    api.on('select', select);
    return () => {
      api.off('select', select);
    };
  }, [api]);
  if (!photos.length) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="gallery-cover"
          aria-label={`Open ${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} of ${title}`}
        >
          <img className="detail-image" src={photos[0]} alt={title} />
          <span>
            <Expand size={16} />
            {photos.length > 1 ? (
              <>
                <Images size={16} />
                {photos.length} photos
              </>
            ) : (
              'View full image'
            )}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="photo-viewer">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Photos from the original listing. Swipe or use the arrows to browse.
        </DialogDescription>
        <Carousel
          opts={{ loop: photos.length > 1 }}
          setApi={setApi}
          className="photo-carousel"
          aria-label="Listing photos"
        >
          <CarouselContent>
            {photos.map((src, position) => (
              <CarouselItem key={src}>
                <div className="full-photo">
                  <img
                    src={src}
                    alt={`${title} — photo ${position + 1}`}
                    loading={position === 0 ? 'eager' : 'lazy'}
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                      event.currentTarget.parentElement?.classList.add('photo-unavailable');
                    }}
                  />
                  <span className="photo-error">
                    This photo is unavailable. View it on the original listing.
                  </span>
                </div>
              </CarouselItem>
            ))}
          </CarouselContent>
          {photos.length > 1 && (
            <>
              <CarouselPrevious className="gallery-prev" />
              <CarouselNext className="gallery-next" />
            </>
          )}
        </Carousel>
        <div className="gallery-footer">
          <span aria-live="polite">
            {current + 1} / {photos.length}
          </span>
          <Button variant="ghost" asChild>
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              Original listing <ExternalLink size={15} />
            </a>
          </Button>
        </div>
        {photos.length > 1 && (
          <div className="gallery-thumbnails" aria-label="Choose a photo">
            {photos.map((src, position) => (
              <button
                key={src}
                aria-label={`Show photo ${position + 1}`}
                aria-current={current === position ? 'true' : undefined}
                onClick={() => api?.scrollTo(position)}
              >
                <img src={src} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
