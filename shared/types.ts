// Handoff contract between scraping/image pipeline and slide generator.
// Keep in sync with backend/app/shared/models.py.

export interface ProductSlideInput {
  heroImageUrl: string;          // transparent PNG, hosted at a public URL
  supportingImageUrls: string[]; // rectangular lifestyle/detail images, hosted
  name: string;
  dimensions: string;            // preserve vendor's raw format; do NOT normalize
  description: string;
}

export interface ProductInput {
  heroImageUrl: string;          // transparent PNG, hosted at a public URL
  name: string;
  dimensions: string;            // preserve vendor's raw format; do NOT normalize
  description: string;
}

export interface TwoProductSlideInput {
  productA: ProductInput;
  productB: ProductInput;
}
