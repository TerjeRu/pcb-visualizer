const params = new URLSearchParams(location.search);

if (params.get('state') === 'failed') {
  const show = (id, text) => {
    const element = document.getElementById(id);
    element.textContent = text;
    return element;
  };
  document.getElementById('starting').hidden = true;
  document.getElementById('failed').hidden = false;
  show('reason', params.get('reason') ?? '');
  const detail = params.get('detail') ?? '';
  show('detail', detail).hidden = detail === '';
  show('command', params.get('command') ?? '');
  document.getElementById('retry').addEventListener('click', () => {
    location.search = '?retry=1';
  });
}
