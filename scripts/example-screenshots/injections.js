/**
 * Example screenshot — ephemeral UI tweaks for the bill detail page.
 *
 * Run scripts/example-screenshots/setup.sh first, then paste this into the
 * browser console on /bills/bill-early-vote.
 */

// 1. Remove Delete buttons on comments
document.querySelectorAll('button').forEach(btn => {
  if (btn.textContent.trim() === 'Delete') btn.remove();
});

// 2. Change "Co-sponsors:" to ", " and fix spacing/color
const sponsorsContainer = [...document.querySelectorAll('span')].find(s =>
  s.textContent.includes('Sponsors:') && s.textContent.includes('Rep.')
);
if (sponsorsContainer) {
  sponsorsContainer.querySelectorAll('span').forEach(s => {
    if (s.textContent.trim() === 'Co-sponsors:') { s.textContent = ', '; s.style.marginLeft = '0'; }
    if (s.style.marginRight) s.style.marginRight = '0';
  });
  [...sponsorsContainer.childNodes].forEach(n => {
    if (n.nodeType === 3 && n.textContent.trim() === '') n.remove();
  });
  sponsorsContainer.style.color = '#5e697d';
  const sponsorsRow = sponsorsContainer.closest('div');
  if (sponsorsRow) sponsorsRow.style.color = '#5e697d';
}

// 3. Relocate Committee to Legislature row + fix dot colors
const allDivs = [...document.querySelectorAll('div')];
const committeeDiv = allDivs.find(d => {
  const t = d.textContent.trim();
  return t.startsWith('Committee:') && t.length < 80 && d.children.length <= 3;
});
const legRow = allDivs.find(d => {
  const children = d.children;
  if (children.length < 2 || children.length > 8) return false;
  const t = d.textContent.trim();
  return t.startsWith('House bill') && t.includes('Legislature') && !t.includes('Sponsors') && !t.includes('Committee');
});
if (committeeDiv && legRow) {
  committeeDiv.hidden = true;
  const sep = document.createElement('span');
  sep.textContent = '  ·  ';
  sep.style.color = '#5e697d';
  legRow.appendChild(sep);
  const cs = document.createElement('span');
  cs.textContent = 'Committee: House Elections Committee';
  cs.style.color = '#5e697d';
  cs.style.fontSize = '12px';
  legRow.appendChild(cs);
  [...legRow.querySelectorAll('span')].forEach(s => {
    if (s.textContent === '·' && getComputedStyle(s).color === 'rgb(203, 213, 225)') {
      s.style.color = '#5e697d';
    }
  });
}

// 4. Hide Individual Votes toggle
const ivSpan = [...document.querySelectorAll('span')].find(s => s.textContent === 'Individual votes');
if (ivSpan) { const p = ivSpan.closest('div'); if (p && p.textContent.trim().length < 30) p.hidden = true; }

// 5. Fix Last action spacing
const lastActionSpan = [...document.querySelectorAll('span')].find(s => s.textContent === 'Last action:');
if (lastActionSpan) {
  lastActionSpan.style.marginRight = '4px';
  const dotSpan = [...lastActionSpan.parentElement.querySelectorAll('span')].find(s => s.textContent === '·');
  if (dotSpan) dotSpan.style.marginRight = '5px';
}

// 6. Fix AI Summary dot spacing
const aiHeaderDiv = [...document.querySelectorAll('div')].find(el =>
  el.textContent.trim().startsWith('AI Summary') && el.children.length < 10 && el.textContent.length < 60
);
if (aiHeaderDiv) {
  const dotSpan = [...aiHeaderDiv.querySelectorAll('span')].find(s => s.textContent.includes('·'));
  if (dotSpan && dotSpan.textContent.includes('·based')) {
    dotSpan.textContent = dotSpan.textContent.replace('·based', '· based');
  }
}

console.log('BPC blog injections applied');
