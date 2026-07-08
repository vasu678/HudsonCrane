export type Step = 'input' | 'review' | 'generating' | 'preview' | 'done'
export type Mode = 'single' | 'two'
export type BrokenSet = Set<string>

export interface ScrapeResult {
  name: string
  dimensions: string
  description: string
  images: string[]
}
