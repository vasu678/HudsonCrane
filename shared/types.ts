// Wire-format contract between frontend and backend.
// Keep in sync with backend/app/models.py.
// Property names match the snake_case JSON the API accepts and returns.

export interface ProductSlideInput {
  hero_image_url: string
  supporting_image_urls: string[]
  name: string
  dimensions: string
  description: string
  finalized_hero_url?: string
  drop_shadow?: boolean
}

export interface ProductInput {
  hero_image_url: string
  name: string
  dimensions: string
  description: string
}

export interface TwoProductSlideInput {
  product_a: ProductInput
  product_b: ProductInput
  drop_shadow?: boolean
}

export interface ScrapeResponse {
  name: string
  dimensions: string
  description: string
  images: string[]
}
