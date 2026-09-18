'use client';
import {useEffect,useState} from 'react';
import {Expand,Images,ExternalLink} from 'lucide-react';
import {Dialog,DialogContent,DialogTitle,DialogDescription,DialogTrigger} from '@/components/ui/dialog';
import {Carousel,CarouselContent,CarouselItem,CarouselPrevious,CarouselNext,type CarouselApi} from '@/components/ui/carousel';
import {Button} from '@/components/ui/button';

export default function ListingGallery({images,title,sourceUrl}:{images:string[];title:string;sourceUrl:string}){
 const photos=[...new Set(images.filter(Boolean))];
 const [open,setOpen]=useState(false),[api,setApi]=useState<CarouselApi>(),[index,setIndex]=useState(0);
 useEffect(()=>{if(!api)return;const select=()=>setIndex(api.selectedScrollSnap());select();api.on('select',select);return()=>{api.off('select',select);};},[api]);
 if(!photos.length)return null;
 return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><button className="gallery-cover" aria-label={`Open ${photos.length} ${photos.length===1?'photo':'photos'} of ${title}`}><img className="detail-image" src={photos[0]} alt={title}/><span><Expand size={16}/>{photos.length>1?<><Images size={16}/>{photos.length} photos</>:'View full image'}</span></button></DialogTrigger><DialogContent className="photo-viewer"><DialogTitle>{title}</DialogTitle><DialogDescription>Photos from the original listing. Swipe or use the arrows to browse.</DialogDescription><Carousel opts={{loop:photos.length>1}} setApi={setApi} className="photo-carousel" aria-label="Listing photos"><CarouselContent>{photos.map((src,n)=><CarouselItem key={src}><div className="full-photo"><img src={src} alt={`${title} — photo ${n+1}`} loading={n===0?'eager':'lazy'} onError={e=>{e.currentTarget.style.display='none';e.currentTarget.parentElement?.classList.add('photo-unavailable');}}/><span className="photo-error">This photo is unavailable. View it on the original listing.</span></div></CarouselItem>)}</CarouselContent>{photos.length>1&&<><CarouselPrevious className="gallery-prev"/><CarouselNext className="gallery-next"/></>}</Carousel><div className="gallery-footer"><span aria-live="polite">{index+1} / {photos.length}</span><Button variant="ghost" asChild><a href={sourceUrl} target="_blank" rel="noreferrer">Original listing <ExternalLink size={15}/></a></Button></div>{photos.length>1&&<div className="gallery-thumbnails" aria-label="Choose a photo">{photos.map((src,n)=><button key={src} aria-label={`Show photo ${n+1}`} aria-current={index===n?'true':undefined} onClick={()=>api?.scrollTo(n)}><img src={src} alt="" loading="lazy"/></button>)}</div>}</DialogContent></Dialog>;
}
