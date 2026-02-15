const { useEffect, useMemo, useRef, useState } = React;
const {
  Box, Button, Card, CardContent, Typography, Stack, List, ListItemButton, ListItemText,
  Chip, TextField, Divider, IconButton
} = MaterialUI;

const formatSize = (bytes) => {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let b = bytes;
  let i = 0;
  while (b > 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(2)} ${units[i]}`;
};

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function App() {
  const [videos, setVideos] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [textData, setTextData] = useState(null);
  const [history, setHistory] = useState([]);
  const [instruction, setInstruction] = useState('Исправь пунктуацию и сделай текст читабельным');
  const [leftWidth, setLeftWidth] = useState(36);
  const [mediaWidth, setMediaWidth] = useState(50);
  const videoRef = useRef(null);
  const audioRef = useRef(null);

  const selected = useMemo(() => videos.find((v) => v.id === selectedId), [videos, selectedId]);

  const load = async () => {
    const [v, h] = await Promise.all([api('/api/videos'), api('/api/history')]);
    setVideos(v);
    setHistory(h);
    if (!selectedId && v[0]) setSelectedId(v[0].id);
  };

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!selectedId) return;
    api(`/api/text/${selectedId}`).then(setTextData).catch(() => setTextData({ videoId: selectedId, transcript: [], markers: [] }));
  }, [selectedId]);

  const upload = async (file) => {
    const fd = new FormData();
    fd.append('video', file);
    await fetch('/api/upload', { method: 'POST', body: fd });
    await load();
  };

  const processVideo = async (id) => { await api(`/api/process/${id}`, { method: 'POST' }); await load(); setSelectedId(id); };
  const saveText = async () => { if (selectedId && textData) await api(`/api/text/${selectedId}`, { method: 'PUT', body: JSON.stringify(textData) }); await load(); };
  const refine = async () => { const next = await api(`/api/refine/${selectedId}`, { method: 'POST', body: JSON.stringify({ instruction }) }); setTextData(next); await load(); };

  const activeTime = () => videoRef.current?.currentTime || audioRef.current?.currentTime || 0;
  const seekTo = (time) => { if (videoRef.current) videoRef.current.currentTime = time; if (audioRef.current) audioRef.current.currentTime = time; };

  const captureScreenshot = async () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL('image/png');
    await api(`/api/screenshot/${selectedId}`, { method: 'POST', body: JSON.stringify({ imageBase64, time: video.currentTime }) });
    const fresh = await api(`/api/text/${selectedId}`);
    setTextData(fresh);
    await load();
  };

  const onTextClick = (seg) => seekTo(seg.start || 0);

  const startDrag = (setter) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const current = setter === setLeftWidth ? leftWidth : mediaWidth;
    const handler = (moveEvent) => {
      const delta = ((moveEvent.clientX - startX) / window.innerWidth) * 100;
      const next = Math.min(80, Math.max(20, current + delta));
      setter(next);
    };
    document.addEventListener('mousemove', handler);
    document.addEventListener('mouseup', () => document.removeEventListener('mousemove', handler), { once: true });
  };

  return React.createElement(Box, { className: 'split' },
    React.createElement(Card, { className: 'section' },
      React.createElement(CardContent, null,
        React.createElement(Typography, { variant: 'h6' }, '1) Загрузка новых видео'),
        React.createElement(Stack, { direction: 'row', spacing: 1, alignItems: 'center', mt: 1 },
          React.createElement(Button, { variant: 'contained', component: 'label' }, 'Выбрать и загрузить',
            React.createElement('input', { type: 'file', hidden: true, accept: 'video/*', onChange: (e) => e.target.files[0] && upload(e.target.files[0]) })
          ),
          React.createElement(Button, { variant: 'outlined', onClick: load }, 'Обновить сканирование папки')
        ),
        React.createElement(Typography, { variant: 'body2', mt: 1 }, 'Можно вручную положить файлы в ./data/videos — они появятся в списке автоматически.')
      )
    ),
    React.createElement('div', { className: 'mainSplit', style: { gridTemplateColumns: `${leftWidth}% 6px 1fr` } },
      React.createElement(Card, { className: 'section' }, React.createElement(CardContent, null,
        React.createElement(Typography, { variant: 'h6' }, '2) Загруженные и обработанные видео'),
        React.createElement(List, null, videos.map((v) => React.createElement('div', { key: v.id },
          React.createElement(ListItemButton, { selected: selectedId === v.id, onClick: () => setSelectedId(v.id) },
            React.createElement(ListItemText, {
              primary: v.fileName,
              secondary: `Видео: ${formatSize(v.videoSize)} | Аудио: ${v.audioFile ? formatSize(v.audioSize) : 'нет'} | Текст: ${v.textFile ? formatSize(v.textSize) : 'нет'}`
            }),
            React.createElement(Chip, { size: 'small', label: v.status })
          ),
          React.createElement(Stack, { direction: 'row', spacing: 1, px: 2, pb: 1 },
            React.createElement(Button, { size: 'small', onClick: () => processVideo(v.id), variant: 'outlined' }, 'Запустить обработку'),
            v.audioFile && React.createElement(Button, { size: 'small', href: `/files/audio/${v.audioFile}`, target: '_blank' }, 'Ссылка на аудио'),
            v.textFile && React.createElement(Button, { size: 'small', href: `/files/text/${v.textFile}`, target: '_blank' }, 'Ссылка на текст')
          ),
          React.createElement(Divider, null)
        ))),
        React.createElement(Typography, { variant: 'h6', mt: 2 }, 'История действий'),
        React.createElement(Stack, { direction: 'row', spacing: 1, mb: 1 },
          React.createElement(Button, { size: 'small', color: 'error', onClick: async () => { await api('/api/history', { method: 'DELETE' }); load(); } }, 'Удалить всю историю')
        ),
        React.createElement(List, null, history.slice(0, 40).map((h) => React.createElement(ListItemButton, { key: h.id },
          React.createElement(ListItemText, { primary: `${h.type}: ${h.message}`, secondary: new Date(h.at).toLocaleString() }),
          React.createElement(IconButton, { size: 'small', onClick: async () => { await api(`/api/history/${h.id}`, { method: 'DELETE' }); load(); } }, '🗑️')
        )))
      )),
      React.createElement('div', { className: 'resizer', onMouseDown: startDrag(setLeftWidth) }),
      React.createElement('div', { className: 'rightSplit', style: { gridTemplateColumns: `${mediaWidth}% 6px 1fr` } },
        React.createElement(Card, { className: 'section' }, React.createElement(CardContent, null,
          React.createElement(Typography, { variant: 'h6' }, '3) Просмотр видео/аудио'),
          selected && React.createElement(Stack, { spacing: 1 },
            React.createElement('video', { ref: videoRef, controls: true, src: `/files/videos/${selected.fileName}` }),
            selected.audioFile && React.createElement('audio', { ref: audioRef, controls: true, src: `/files/audio/${selected.audioFile}` }),
            React.createElement(Button, { variant: 'contained', onClick: captureScreenshot }, 'Скриншот текущего кадра')
          )
        )),
        React.createElement('div', { className: 'resizer', onMouseDown: startDrag(setMediaWidth) }),
        React.createElement(Card, { className: 'section' }, React.createElement(CardContent, null,
          React.createElement(Typography, { variant: 'h6' }, 'Текст (синхронизирован с таймлайном)'),
          React.createElement(Stack, { direction: 'row', spacing: 1, my: 1 },
            React.createElement(Button, { variant: 'outlined', onClick: saveText }, 'Сохранить правки'),
            React.createElement(Button, { variant: 'contained', onClick: refine }, 'Улучшить через LLM')
          ),
          React.createElement(TextField, {
            fullWidth: true,
            multiline: true,
            minRows: 2,
            label: 'Инструкция для LLM',
            value: instruction,
            onChange: (e) => setInstruction(e.target.value)
          }),
          React.createElement(Box, { mt: 2 }, textData?.transcript?.map((seg, idx) => React.createElement('div', {
            key: `${idx}-${seg.start}`,
            className: `textRow ${Math.abs((seg.start || 0) - activeTime()) < 1.5 ? 'activeRow' : ''}`,
            onClick: () => onTextClick(seg)
          },
            React.createElement(Typography, { variant: 'caption' }, `${(seg.start || 0).toFixed(2)}s - ${(seg.end || 0).toFixed(2)}s`),
            React.createElement('textarea', {
              value: seg.text,
              onChange: (e) => {
                const copy = structuredClone(textData);
                copy.transcript[idx].text = e.target.value;
                setTextData(copy);
              }
            })
          )))
        ))
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
