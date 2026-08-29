// 生成一份最小的多页 PDF(每页一行大字),给 e2e 当夹具用 —— 仓库里不放二进制夹具,
// 也不必为一个测试装 pdfkit。xref 偏移是按实际字节算的,PDFium / pdf.js 都能正常打开。
function tinyPdf(lines) {
  const objs = []
  const kids = lines.map((_, i) => `${4 + i * 2} 0 R`).join(' ')
  objs.push('<< /Type /Catalog /Pages 2 0 R >>')
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${lines.length} >>`)
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  lines.forEach((line) => {
    // 14pt:36pt 时长句会跑出 MediaBox 右边界,pdf.js 的 getTextContent 只吐得出页面内那一截
    // (实测截在第 29 个字符),find 就永远匹配不上 —— 夹具的字号是断言能不能成立的一部分。
    // 一行可以给成数组 → 连着几个 Tj(同一行、多个 text item)= 文本层里的多个 span,
    // 用来复现「一处匹配跨 span」这种真书里最常见的形态(pdf-highlight-geometry.check)
    // 数组元素可以是字符串(Tj)或 [dx, dy](Td 位移);连着两个 Tj 会被 pdf.js 并成一个 item,
    // 中间插一次 Td 才会拆成两个 text item = 文本层里两个 span。
    const segs = (Array.isArray(line) ? line : [line])
      .map((s) => (Array.isArray(s) ? `${s[0]} ${s[1]} Td` : `(${String(s).replace(/([()\\])/g, '\\$1')}) Tj`))
      .join(' ')
    const stream = `BT /F1 14 Tf 60 400 Td ${segs} ET`
    objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (objs.length + 2) + ' 0 R >>')
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
module.exports = { tinyPdf }
