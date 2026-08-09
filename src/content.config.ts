import {defineCollection, z} from 'astro:content';
import {glob} from 'astro/loaders';

const posts = defineCollection({
  loader: glob({pattern: '**/*.{md,mdx}', base: './src/content/posts'}),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    lang: z.enum(['es', 'en']),
    slug: z.string().optional(),
    videoId: z.string().optional(),
    videoUrl: z.string().optional(),
    duration: z.string().optional(),
    color: z.string().default('#ff6a00'),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = {posts};
