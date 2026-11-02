interface ImageLoaderParams {
  src: string;
  width: number;
  quality?: number;
}

/**
 * Images are loaded from their original origin. Private Storage URLs may contain
 * short-lived credentials and must never be forwarded to a third-party CDN.
 * Public assets also stay on this installation's configured origin.
 */
export default function imageLoader({ src }: ImageLoaderParams): string {
  return src;
}
