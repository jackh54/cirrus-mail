// Copy buttons for code blocks. Falls back to selecting the text when the Clipboard API is unavailable.
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    const text = target.innerText.replace(/^\$ /gm, '');
    const done = (label) => {
      button.textContent = label;
      setTimeout(() => (button.textContent = 'Copy'), 1600);
    };
    const select = () => {
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      done('Press ⌘C / Ctrl+C');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => done('Copied'), select);
    } else {
      select();
    }
  });
}
