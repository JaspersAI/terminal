import { definePlugin, defineSource } from '@jaspers-ai/sdk'
import { z } from 'zod'

// A document producer: a source that writes a file under the plugin's data folder,
// ~/Jaspers/document/, and opens it in its default app. It needs the files capability. This one
// writes a Markdown report from a title and sections the assistant passes; a producer of PDFs or
// spreadsheets does the same with a package (pdf-lib, exceljs) named in install_plugin's packages.

const report = defineSource({
  description:
    "Writes a Markdown report to the plugin's folder and opens it. Pass a title and sections, each with a heading and body text; answers the path written.",
  input: z.object({
    title: z.string().min(1).describe('The report title, also its file name.'),
    sections: z
      .array(z.object({ heading: z.string(), body: z.string() }))
      .min(1)
      .describe('The sections in order. Body text is Markdown.'),
  }),
  async run(args, ctx) {
    const name =
      args.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'report'
    const path = `reports/${name}.md`
    const lines = [`# ${args.title}`, '', `_${new Date().toISOString().slice(0, 10)}_`, '']
    for (const section of args.sections) lines.push(`## ${section.heading}`, '', section.body.trim(), '')
    await ctx.files.write(path, lines.join('\n'))
    await ctx.files.open(path)
    return { path, sections: args.sections.length }
  },
})

export default definePlugin({ id: 'document', capabilities: ['files'], sources: { report } })
