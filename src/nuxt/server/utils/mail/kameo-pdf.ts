/**
 * Genererar PDF av ett räntebetalningsmejl.
 *
 * PDF:en används som bokföringsunderlag och ska därför innehålla
 * - originalets rubrik, avsändare och datum
 * - lånenummer, belopp och vilket konto beloppet bokförs på
 * - mejlets brödtext, avkodad till ren text
 */

import PDFDocument from 'pdfkit'

export interface InterestPdfInput {
  fileName: string
  subject: string
  from: string
  date: string
  loanNumber: number
  amount: number
  account: string
  body: string
}

/**
 * Formaterar ett belopp på svkt sätt.
 */
function formatAmount(amount: number): string {
  return amount.toFixed(2).replace('.', ',')
}

/**
 * Formaterar ett ISO-datum som "2026-11-16".
 */
function formatDate(date: string): string {
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) {
    return date
  }
  return parsed.toISOString().slice(0, 10)
}

/**
 * Bygger PDF:en och returnerar bufferten.
 */
export function buildInterestPdf(input: InterestPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: input.subject,
        Author: input.from,
        Subject: `Kameo ränteutbetalning lån ${input.loanNumber}`,
      },
    })

    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.font('Helvetica-Bold').fontSize(16).text('Kameo - Ränteutbetalning', { align: 'left' })
    doc.moveDown(0.5)

    doc.font('Helvetica').fontSize(11)

    const row = (label: string, value: string) => {
      doc.font('Helvetica-Bold').text(`${label}: `, { continued: true })
      doc.font('Helvetica').text(value)
      doc.moveDown(0.25)
    }

    row('Ämne', input.subject)
    row('Från', input.from)
    row('Datum', formatDate(input.date))
    row('Lånenummer', String(input.loanNumber))
    row('Belopp', `${formatAmount(input.amount)} SEK`)
    row('Konto', input.account)
    row('Filnamn', input.fileName)

    doc.moveDown(0.8)
    doc
      .moveTo(doc.x, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .stroke()
    doc.moveDown(0.8)

    doc.font('Helvetica-Bold').fontSize(12).text('Mejlets innehåll')
    doc.moveDown(0.4)
    doc.font('Helvetica').fontSize(10).text(input.body || '(tomt)', { align: 'left' })

    doc.end()
  })
}
