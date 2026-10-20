import { Image } from './ui/image';
import { EMPTY_ILLUSTRATION_URLS, type EmptyIllustrationKind } from '../lib/visual-assets';
import './product-visuals.css';

/** A clear, compact D-shaped path: a creator connection moving towards a result. */
export function ProductMark({ className = '' }: { className?: string }) {
  return <svg className={`product-mark ${className}`.trim()} viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
    <rect width="48" height="48" rx="14" fill="#3158DC" />
    <path d="M14 32V17a4 4 0 0 1 4-4h6a11 11 0 1 1 0 22h-3" stroke="white" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m14 32 6-6m-6 6h7" stroke="#BBD4FF" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/** Decorative artwork; nearby copy provides the accessible empty-state message. */
export function EmptyIllustration({ kind, className = '' }: { kind: EmptyIllustrationKind; className?: string }) {
  return <Image
    src={EMPTY_ILLUSTRATION_URLS[kind]}
    width={160}
    height={160}
    alt=""
    aria-hidden="true"
    className={`empty-illustration ${className}`.trim()}
    decoding="async"
    loading="eager"
  />;
}
