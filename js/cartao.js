// Arte do cartão físico — estilo letreiro vintage (mesmo visual do site)
// Usado pelo gerador do admin e pelo preview do cadastro.
// Cartão 9x5cm + 2mm de sangria por lado = 94x54mm @ 300dpi
const CARD_W = 1110, CARD_H = 638

// "Barbearia do João" → destaque "João" · "Corte Fino" → destaque "Corte Fino"
function splitShopName(name) {
  const m = String(name || '').match(/^\s*barbearia\s*(do|da|de|dos|das)?\s+/i)
  const resto = m ? name.slice(m[0].length).trim() : ''
  return resto || String(name || '').trim()
}

function cardBase(canvas, cor) {
  canvas.width = CARD_W; canvas.height = CARD_H
  const x = canvas.getContext('2d')
  x.fillStyle = '#0F172A'
  x.fillRect(0, 0, CARD_W, CARD_H)
  // barra superior na cor da barbearia
  const g = x.createLinearGradient(0, 0, CARD_W, 0)
  g.addColorStop(0, cor); g.addColorStop(0.65, cor); g.addColorStop(1, 'rgba(0,0,0,0)')
  x.fillStyle = g
  x.fillRect(0, 0, CARD_W, 10)
  return x
}

function drawScissors(x, cx, cy, size, cor) {
  const s = size / 24
  x.save()
  x.translate(cx - 12 * s, cy - 12 * s)
  x.scale(s, s)
  x.strokeStyle = cor
  x.lineWidth = 1.7
  x.lineCap = 'round'
  x.lineJoin = 'round'
  x.beginPath(); x.arc(6, 6, 2.6, 0, Math.PI * 2); x.stroke()
  x.beginPath(); x.arc(6, 18, 2.6, 0, Math.PI * 2); x.stroke()
  x.beginPath(); x.moveTo(20, 4); x.lineTo(8.2, 15.8); x.stroke()
  x.beginPath(); x.moveTo(14.5, 14.5); x.lineTo(20, 20); x.stroke()
  x.beginPath(); x.moveTo(8.2, 8.2); x.lineTo(12, 12); x.stroke()
  x.restore()
}

function drawOrnament(x, cx, cy, width, cor) {
  const half = width / 2
  const gLeft = x.createLinearGradient(cx - half, 0, cx - 24, 0)
  gLeft.addColorStop(0, 'rgba(0,0,0,0)'); gLeft.addColorStop(1, cor)
  x.fillStyle = gLeft
  x.fillRect(cx - half, cy - 1.5, half - 24, 3)
  const gRight = x.createLinearGradient(cx + 24, 0, cx + half, 0)
  gRight.addColorStop(0, cor); gRight.addColorStop(1, 'rgba(0,0,0,0)')
  x.fillStyle = gRight
  x.fillRect(cx + 24, cy - 1.5, half - 24, 3)
  // losango central
  x.fillStyle = cor
  x.save()
  x.translate(cx, cy)
  x.rotate(Math.PI / 4)
  x.fillRect(-7, -7, 14, 14)
  x.restore()
}

function fitFont(x, text, family, weight, startPx, minPx, maxW, italic) {
  let px = startPx
  const style = italic ? 'italic ' : ''
  x.font = `${style}${weight} ${px}px ${family}`
  while (px > minPx && x.measureText(text).width > maxW) {
    px -= 4
    x.font = `${style}${weight} ${px}px ${family}`
  }
  return px
}

function spaced(text) { return text.toUpperCase().split('').join('  ') }

function drawCardFront(canvas, name, cor) {
  const x = cardBase(canvas, cor)
  const cx = CARD_W / 2
  const destaque = splitShopName(name)

  drawScissors(x, cx, 108, 64, cor)

  x.textAlign = 'center'
  x.textBaseline = 'alphabetic'

  // selo BARBEARIA
  x.fillStyle = cor
  x.font = '600 27px Inter, Arial'
  x.fillText('— ' + spaced('Barbearia') + ' —', cx, 208)

  // nome em destaque
  x.fillStyle = '#F8FAFC'
  fitFont(x, destaque, '"Playfair Display", Georgia, serif', 700, 118, 54, CARD_W - 180)
  x.fillText(destaque, cx, 348)

  drawOrnament(x, cx, 408, 420, cor)

  // tagline em itálico
  x.fillStyle = cor
  x.font = 'italic 500 44px "Playfair Display", Georgia, serif'
  x.fillText('Agende seu horário', cx, 500)
}

function drawCardBack(canvas, cor, link) {
  const x = cardBase(canvas, cor)
  const cx = CARD_W / 2

  const qr = qrcode(0, 'M')
  qr.addData(link)
  qr.make()
  const n = qr.getModuleCount()
  const qsize = 380, cell = qsize / n
  const qx = cx - qsize / 2, qy = 92

  x.fillStyle = '#FFFFFF'
  x.beginPath()
  x.roundRect(qx - 26, qy - 26, qsize + 52, qsize + 52, 26)
  x.fill()
  x.fillStyle = '#0F172A'
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) x.fillRect(qx + c * cell, qy + r * cell, Math.ceil(cell), Math.ceil(cell))

  x.textAlign = 'center'
  x.fillStyle = '#94A3B8'
  x.font = '600 27px Inter, Arial'
  x.fillText(spaced('Aponte a câmera e agende'), cx, qy + qsize + 88)
}

async function loadCardFonts() {
  try {
    await Promise.all([
      document.fonts.load('700 118px "Playfair Display"'),
      document.fonts.load('italic 500 44px "Playfair Display"'),
      document.fonts.load('600 27px Inter'),
    ])
  } catch (e) { /* segue com as fontes reservas */ }
}
