import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Terminal as TerminalIcon, Home, Folder, File, Play, Pause, Volume2, VolumeX, Image as ImageIcon, Code, Users, Maximize2, Minimize2, Upload, CheckCircle2, Power, FileCode, Save, Mic, MicOff, Wifi, LogOut, Settings, Shield, Activity, Cpu, Layers, StopCircle, RefreshCw, Send, Sparkles, Bot, Copy, Check, Video, Wand2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { LocalExplorer, LocalFilePane, RealShell, ModeSwitch, ModeBanner, useMode, isDesktop } from './desktop/local';
import { Canvas, CanvasVersion, loadVersions, saveVersions, addVersion, addArtifact } from './desktop/canvas';
import { Artifact, fromShellOutput, fromFile, fromMillaReply, fromMedia, explicitFile, kindOfPath, isMediaKind } from './desktop/artifact';
import { htmlFromReply, titleOf } from './desktop/canvas-util';
// Local-only: no cloud accounts. The single user is Danny.
type User = { uid: string; displayName?: string | null; email?: string | null };

// Types
type VFSNode = { path: string, type: 'file' | 'dir', content?: string, children?: string[], ownerId?: string, updatedAt?: number };
type VFS = Record<string, VFSNode>;

type HistoryEntry = {
  id: string;
  type: 'command' | 'output' | 'error' | 'image' | 'video' | 'sandbox';
  text?: string;
  url?: string;
  pip?: boolean;
  code?: string;
  timestamp: number;
  userId: string;
};

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [vfs, setVfs] = useState<VFS>({});
  const vfsLatest = useRef<VFS>({});
  vfsLatest.current = vfs;
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [input, setInput] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [rightPanel, setRightPanel] = useState<'sandbox' | 'editor' | 'sandbox-monitor' | 'gemini-chat' | null>(null);
  const rightPanelRef = useRef(rightPanel);
  rightPanelRef.current = rightPanel;
  const [activeSandbox, setActiveSandbox] = useState<string | null>(null);
  // v0.3 canvas: everything Milla builds opens here (versions survive restarts).
  const [canvasVersions, setCanvasVersionsRaw] = useState<CanvasVersion[]>(() => loadVersions());
  const [canvasActive, setCanvasActive] = useState<string | null>(null);
  const [canvasOpen, setCanvasOpen] = useState(true);
  const [canvasRevising, setCanvasRevising] = useState(false);
  const setCanvasVersions = (v: CanvasVersion[]) => { setCanvasVersionsRaw(v); saveVersions(v); };
  const canvasRef = useRef<{ list: CanvasVersion[] }>({ list: canvasVersions });
  canvasRef.current.list = canvasVersions;
  const openInCanvas = (html: string, source: string, title?: string) => {
    const next = addVersion(canvasRef.current.list, html, title || titleOf(html), source);
    setCanvasVersions(next); setCanvasActive(next[next.length - 1].id); setCanvasOpen(true);
    setRightPanel('gemini-chat');
  };
  const openInCanvasRef = useRef(openInCanvas);
  openInCanvasRef.current = openInCanvas;
  // v0.4: automatic canvas. New renderable output becomes a version; "follow" decides if it takes over the view.
  const [canvasFollow, setCanvasFollowRaw] = useState(() => localStorage.getItem('aetherterm_canvas_follow') !== '0');
  const setCanvasFollow = (v: boolean) => { setCanvasFollowRaw(v); localStorage.setItem('aetherterm_canvas_follow', v ? '1' : '0'); };
  const [canvasUnseen, setCanvasUnseen] = useState(0);
  const autoCanvas = (a: Artifact | null, opts: { force?: boolean } = {}) => {
    if (!a) return;
    if (a.origin === 'real' && modeRef.current !== 'real') return; // never show real files outside Real mode
    const before = canvasRef.current.list;
    const next = addArtifact(before, a);
    if (next === before) return;
    setCanvasVersions(next);
    const follow = opts.force || followRef.current;
    const panel = rightPanelRef.current;
    if (follow && (opts.force || panel === null || panel === 'gemini-chat')) {
      setCanvasActive(next[next.length - 1].id); setCanvasOpen(true); setRightPanel('gemini-chat'); setCanvasUnseen(0);
      // Don't let a preview take the keyboard away from the terminal.
      const had = document.activeElement as HTMLElement | null;
      const restore = () => { if (had && had !== document.body && document.activeElement?.tagName === 'IFRAME') had.focus({ preventScroll: true }); };
      setTimeout(restore, 300); setTimeout(restore, 1200);
    } else {
      setCanvasUnseen((u) => u + 1);
    }
  };
  const autoCanvasRef = useRef(autoCanvas);
  autoCanvasRef.current = autoCanvas;
  const followRef = useRef(canvasFollow);
  followRef.current = canvasFollow;
  const lastCmdRef = useRef('');
  const vfsRef = vfsLatest;
  /** Live terminal history -> canvas (shell output, media, generated apps, Milla's chat replies). */
  const autoFromEntry = (entry: any) => {
    if (!entry) return;
    const resolve = (u?: string) => (u && u.startsWith('/') && vfsRef.current[u]?.content) ? vfsRef.current[u].content! : (u || '');
    if (entry.type === 'command') { lastCmdRef.current = String(entry.text || '').replace(/^.*? \$ /, ''); return; }
    if (entry.type === 'sandbox' && entry.code) { autoCanvas(fromShellOutput(entry.code, { command: lastCmdRef.current, origin: 'sandbox' }) || { kind: 'html', html: entry.code, raw: entry.code, title: 'App', source: 'shell', origin: 'sandbox' }); return; }
    if (entry.type === 'image' && entry.url) { autoCanvas(fromMedia('image', resolve(entry.url), String(entry.url).split('/').pop() || 'image', `shell: ${lastCmdRef.current}`, 'sandbox')); return; }
    if (entry.type === 'video' && entry.url) {
      const k = kindOfPath(entry.url) === 'audio' ? 'audio' : 'video';
      autoCanvas(fromMedia(k, resolve(entry.url), String(entry.url).split('/').pop() || k, `shell: ${lastCmdRef.current}`, entry.url.startsWith('/api/local/') ? 'real' : 'sandbox'));
      return;
    }
    if (entry.type === 'output' && entry.isChat) { if (entry.sender === 'Milla') autoCanvas(fromMillaReply(entry.text || '')); return; }
    if (entry.type === 'output' && !entry.isError && typeof entry.text === 'string') autoCanvas(fromShellOutput(entry.text, { path: entry.path, command: lastCmdRef.current, origin: 'sandbox' }));
  };
  const autoFromEntryRef = useRef(autoFromEntry);
  autoFromEntryRef.current = autoFromEntry;
  // Files opened in Local Folders, and `canvas FILE` typed in the real shell (Real mode only).
  useEffect(() => {
    const onFile = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      autoCanvasRef.current(fromFile(`${d.root}/${d.rel}`, d.content, { url: d.url, origin: 'real' }));
    };
    const onCanvasFile = async (e: Event) => {
      const abs = String((e as CustomEvent).detail?.abs || '');
      if (!abs || modeRef.current !== 'real') return;
      const k = kindOfPath(abs);
      const name = abs.split('/').pop() || abs;
      if (k && isMediaKind(k)) { autoCanvasRef.current(fromMedia(k as any, `/api/local/raw?abs=${encodeURIComponent(abs)}`, name, `bash: canvas ${abs}`, 'real'), { force: true }); return; }
      try {
        const r = await fetch(`/api/local/read?abs=${encodeURIComponent(abs)}`, { credentials: 'same-origin' });
        const j = await r.json();
        if (!r.ok || j.binary) throw new Error(j.error || (j.tooLarge ? 'too large (over 5 MB)' : 'binary file'));
        autoCanvasRef.current(explicitFile(abs, j.content || '', 'real', `bash: canvas ${abs}`), { force: true });
      } catch (err: any) {
        console.warn('canvas:', abs, err?.message || err);
      }
    };
    window.addEventListener('aether-file-opened', onFile);
    window.addEventListener('aether-canvas-file', onCanvasFile);
    return () => { window.removeEventListener('aether-file-opened', onFile); window.removeEventListener('aether-canvas-file', onCanvasFile); };
  }, []);
  useEffect(() => { (window as any).__aetherOpenInCanvas = (html: string, source = 'test') => openInCanvasRef.current(html, source); }, []);
  const [editorFile, setEditorFile] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [showSetup, setShowSetup] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const [bootStarted, setBootStarted] = useState(false);
  const getInitialBootVideo = () => {
    const saved = localStorage.getItem('aetherterm_boot_video');
    if (!saved || saved.includes('TearsOfSteel.mp4')) {
      localStorage.setItem('aetherterm_boot_video', '/boot-video.mp4');
      return '/boot-video.mp4';
    }
    return saved;
  };
  const [bootVideo, setBootVideo] = useState(getInitialBootVideo());
  const [isListening, setIsListening] = useState(false);
  const [prediction, setPrediction] = useState('');
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [sandboxMetrics, setSandboxMetrics] = useState<{ workspaceSize: string, processes: any[] }>({ workspaceSize: '0 KB', processes: [] });

  const [sessionId, setSessionId] = useState(() => {
    return new URLSearchParams(window.location.search).get('session') || 'lobby';
  });
  const mode = useMode(); // 'sandbox' | 'real' (v0.3; replaces the old cosmetic SANDBOX toggle)
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Real-file versions stay stored but are hidden while the Sandbox is on.
  const visibleVersions = mode === 'real' ? canvasVersions : canvasVersions.filter((v) => v.origin !== 'real');
  const setVisibleVersions = (v: CanvasVersion[]) => {
    const hidden = mode === 'real' ? [] : canvasVersions.filter((x) => x.origin === 'real');
    setCanvasVersions([...hidden, ...v].sort((a, b) => a.n - b.n));
  };
  // v0.4: Home follows the mode. The server says where Home is and where the virtual shell is.
  const [shellInfo, setShellInfo] = useState<{ mode: string; home: string; virtualHome: string; cwd: string; display: string }>(
    { mode: 'sandbox', home: '/home/danny', virtualHome: '/home/danny', cwd: '/home/danny', display: '~' });
  const virtualHome = shellInfo.virtualHome || '/home/danny';
  const [typingUser, setTypingUser] = useState<string | null>(null);
  const [millaTyping, setMillaTyping] = useState(false);

  // Gemini Workspace States
  const [geminiMode, setGeminiMode] = useState<'chat' | 'image' | 'video' | 'code'>('chat');
  const [geminiPrompt, setGeminiPrompt] = useState('');
  const [geminiChatHistory, setGeminiChatHistory] = useState<Array<{ role: 'user' | 'model', content: string, mediaUrl?: string, mediaType?: 'image' | 'video' }>>([]);
  const [geminiLoading, setGeminiLoading] = useState(false);
  const [videoOperationName, setVideoOperationName] = useState<string | null>(null);

  // Tab completion commands
  const ALL_COMMANDS = ['help', 'clear', 'cd', 'pwd', 'ls', 'cat', 'mkdir', 'touch', 'echo', 'play', 'pip', 'view', 'ask', 'generate-app', 'generate-image', 'github', 'github-sync', 'agent', 'local-ask', 'ollama', 'set-boot', 'edit', 'nix', 'pkg', 'sandbox'];
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  // v0.4: v0.3.1 saved the retired 1660 Ti Ollama (:11435) as the default; drop that so :11434 is used again.
  if (localStorage.getItem('aetherterm_ollama_url') === 'http://127.0.0.1:11435') localStorage.removeItem('aetherterm_ollama_url');
  const [apiKeys, setApiKeys] = useState({
    openai: localStorage.getItem('aetherterm_openai_key') || '',
    anthropic: localStorage.getItem('aetherterm_anthropic_key') || '',
    gemini: localStorage.getItem('aetherterm_gemini_key') || '',
    ollamaUrl: localStorage.getItem('aetherterm_ollama_url') || 'http://127.0.0.1:11434',
  });
  const [ollamaModel, setOllamaModel] = useState(localStorage.getItem('aetherterm_ollama_model') || 'devmilla:latest');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  // Tell the server which local model to use for Milla (picked in Settings).
  useEffect(() => { if (socket && ollamaModel) socket.emit('use_model', { model: ollamaModel }); }, [socket, ollamaModel]);
  const [ollamaModelError, setOllamaModelError] = useState('');
  const [defaultLlm, setDefaultLlm] = useState(localStorage.getItem('aetherterm_default_llm') || 'local');
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const asciiArt = `███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗    ██████╗  █████╗ ██╗   ██╗███╗   ██╗███████╗
████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝    ██╔══██╗██╔══██╗╚██╗ ██╔╝████╗  ██║██╔════╝
██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗    ██████╔╝███████║ ╚████╔╝ ██╔██╗ ██║█████╗  
██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║    ██╔══██╗██╔══██║  ╚██╔╝  ██║╚██╗██║██╔══╝  
██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║    ██║  ██║██║  ██║   ██║   ██║ ╚████║███████╗
╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝    ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═══╝╚══════╝`;

  const renderAscii = (text: string) => {
    return text.split('\n').map((line, lineIdx) => (
      <div key={lineIdx}>
        {line.split('').map((char, charIdx) => {
          if (char === '█') return <span key={charIdx} className="ascii-front">{char}</span>;
          if (['╗', '║', '╚', '╔', '╝', '═'].includes(char)) return <span key={charIdx} className="ascii-shadow">{char}</span>;
          return char;
        })}
      </div>
    ));
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !socket) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      socket.emit('upload_file', { path: `${virtualHome}/${file.name}`, content, vfs });
    };
    reader.readAsDataURL(file);
  };

  const handleMountLocal = async () => {
    try {
      // @ts-ignore - File System Access API
      const dirHandle = await window.showDirectoryPicker();
      const localRoot = `${virtualHome}/imported`;
      
      const newNodes: VFSNode[] = [];
      newNodes.push({ path: localRoot, type: 'dir', children: [], ownerId: user?.uid || 'local', updatedAt: Date.now() });

      const processHandle = async (handle: any, currentPath: string) => {
        if (handle.kind === 'file') {
          const file = await handle.getFile();
          try {
            const content = await file.text();
            newNodes.push({ path: currentPath, type: 'file', content, ownerId: user?.uid || 'local', updatedAt: Date.now() });
          } catch (e) {
            // Skip binary files
          }
          return currentPath;
        } else if (handle.kind === 'directory') {
          const children = [];
          for await (const entry of handle.values()) {
            const childPath = `${currentPath}/${entry.name}`;
            children.push(childPath);
            await processHandle(entry, childPath);
          }
          newNodes.push({ path: currentPath, type: 'dir', children, ownerId: user?.uid || 'local', updatedAt: Date.now() });
          return currentPath;
        }
      };

      await processHandle(dirHandle, localRoot);
      
      if (vfs[virtualHome]) {
        if (!vfs[virtualHome].children?.includes(localRoot)) {
          newNodes.push({ ...vfs[virtualHome], children: [...(vfs[virtualHome].children || []), localRoot] });
        }
      }

      socket?.emit('sync_vfs_batch', { nodes: newNodes });
      setHistory(prev => [...prev, { id: Date.now().toString(), type: 'output', text: `Imported a copy of the folder to ${localRoot}`, timestamp: Date.now(), userId: user?.uid || 'local' }]);
      
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setHistory(prev => [...prev, { id: Date.now().toString(), type: 'error', text: `Failed to mount local directory: ${err.message}`, timestamp: Date.now(), userId: user?.uid || 'local' }]);
      }
    }
  };

  useEffect(() => {
    setIsAuthReady(true);
  }, []);

  useEffect(() => {
    if (!isAuthReady) return;

    if (!user) {
      setIsLocalMode(true);
    } else {
      setIsLocalMode(false);
    }

    if (!localStorage.getItem('aetherterm_setup_complete')) {
      setShowSetup(true);
    }

    const newSocket = io();
    setSocket(newSocket);

    newSocket.emit('join', {
      username: user ? (user.displayName || user.email?.split('@')[0]) : 'Danny',
      sessionId
    });

    let unsubscribeVfs = () => {};
    let unsubscribeHistory = () => {};

    {
      // Local Mode VFS
      const initialVfs: VFS = {
        '/': { path: '/', type: 'dir', children: ['/home', '/bin'], ownerId: 'local', updatedAt: Date.now() },
        '/home': { path: '/home', type: 'dir', children: [], ownerId: 'local', updatedAt: Date.now() },
        '/bin': { path: '/bin', type: 'dir', children: [], ownerId: 'local', updatedAt: Date.now() },
      };
      setVfs(initialVfs);
      setHistory([]);
    }

    newSocket.on('milla_typing', (on: boolean) => setMillaTyping(!!on));
    newSocket.on('shell_home', (info: any) => { if (info && typeof info.cwd === 'string') setShellInfo(info); });

    newSocket.on('sync_all_history', (serverHistory: HistoryEntry[]) => {
      setHistory(serverHistory);
    });

    newSocket.on('sync_all_vfs', (serverVfs: VFSNode[]) => {
      setVfs(prev => {
        const next = { ...prev };
        serverVfs.forEach(n => next[n.path] = n);
        return next;
      });
    });

    newSocket.on('editor_change', (data: { path: string, content: string }) => {
      if (editorFile === data.path) {
        setEditorContent(data.content);
      }
    });

    newSocket.on('open_sandbox_monitor', () => {
      setRightPanel('sandbox-monitor');
    });

    newSocket.on('sandbox_metrics', (data: { workspaceSize: string, processes: any[] }) => {
      setSandboxMetrics(data);
    });

    newSocket.on('users_update', (users: string[]) => {
      setOnlineUsers(users);
    });

    newSocket.on('sync_vfs', (nodes: VFSNode[]) => {
      setVfs(prev => {
        const next = { ...prev };
        nodes.forEach(n => next[n.path] = n);
        return next;
      });
    });

    newSocket.on('purge_vfs_paths', (paths: string[]) => {
      setVfs(prev => {
        const next = { ...prev };
        paths.forEach(p => delete next[p]);
        return next;
      });
    });

    newSocket.on('sync_history', (entry: any) => {
      if (entry?.canvas) {
        // `canvas <file>` in the virtual shell: always opens.
        autoCanvasRef.current(explicitFile(entry.path || 'file', entry.text || '', 'sandbox', `shell: canvas ${entry.path}`), { force: true });
        setHistory(prev => [...prev, { ...entry, text: `Opened ${entry.path} in the canvas.` }]);
        return;
      }
      setHistory(prev => [...prev, entry]);
      autoFromEntryRef.current(entry);
    });

    newSocket.on('open_editor', (data: { path: string, content: string }) => {
      setEditorFile(data.path);
      setEditorContent(data.content);
      setRightPanel('editor');
    });

    newSocket.on('request_ollama_models', async (data: { id: string }) => {
      try {
        const ollamaUrl = localStorage.getItem('aetherterm_ollama_url') || 'http://127.0.0.1:11434';
        const response = await fetch(`${ollamaUrl}/api/tags`);
        if (response.ok) {
          const result = await response.json();
          newSocket.emit(`response_ollama_models_${data.id}`, { models: result.models });
        } else {
          newSocket.emit(`response_ollama_models_${data.id}`, { error: `Ollama returned status ${response.status}` });
        }
      } catch (err: any) {
        newSocket.emit(`response_ollama_models_${data.id}`, { error: `Could not connect to Ollama.` });
      }
    });

    newSocket.on('set_ollama_model', (data: { model: string }) => {
      if (!data?.model) return;
      localStorage.setItem('aetherterm_ollama_model', data.model);
      setOllamaModel(data.model);
    });

    newSocket.on('ollama_defaults', (data: { model?: string; url?: string }) => {
      if (data?.model && !localStorage.getItem('aetherterm_ollama_model')) {
        localStorage.setItem('aetherterm_ollama_model', data.model);
        setOllamaModel(data.model);
      }
      if (data?.url && !localStorage.getItem('aetherterm_ollama_url')) {
        localStorage.setItem('aetherterm_ollama_url', data.url);
        setApiKeys(prev => ({ ...prev, ollamaUrl: data.url as string }));
      }
    });

    newSocket.on('request_local_llm', async (data: { id: string, prompt: string }) => {
      try {
        const ollamaUrl = localStorage.getItem('aetherterm_ollama_url') || 'http://127.0.0.1:11434';
        const model = localStorage.getItem('aetherterm_ollama_model') || 'devmilla:latest';
        const response = await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model,
            prompt: data.prompt,
            stream: false
          })
        });
        if (response.ok) {
          const result = await response.json();
          newSocket.emit(`response_local_llm_${data.id}`, { text: result.response });
        } else {
          newSocket.emit(`response_local_llm_${data.id}`, { error: `Ollama returned status ${response.status}` });
        }
      } catch (err: any) {
        newSocket.emit(`response_local_llm_${data.id}`, { error: `Could not connect to Ollama. Make sure it is running locally and CORS is configured.` });
      }
    });

    newSocket.on('sync_input', (data: { text: string, user: string }) => {
      setInput(data.text);
      if (data.user && data.user !== (user ? (user.displayName || user.email?.split('@')[0]) : 'Danny')) {
        setTypingUser(data.user);
      } else {
        setTypingUser(null);
      }
    });

    newSocket.on('gemini_chat_response', (data: any) => {
      setGeminiLoading(false);
      if (data.error) {
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Error: ${data.error}` }]);
      } else {
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: data.text }]);
        autoCanvasRef.current(fromMillaReply(data.text));
      }
    });

    newSocket.on('gemini_generate_image_response', (data: any) => {
      setGeminiLoading(false);
      if (data.error) {
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Error generating image: ${data.error}` }]);
      } else {
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Generated successfully: [File: ${data.filepath}]`, mediaUrl: data.url, mediaType: 'image' }]);
        autoCanvasRef.current(fromMedia('image', data.url, String(data.filepath || 'image').split('/').pop() || 'image', 'Milla', 'sandbox'));
      }
    });

    newSocket.on('gemini_generate_video_response', (data: any) => {
      if (data.error) {
        setGeminiLoading(false);
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Error initiating video generation: ${data.error}` }]);
      } else {
        setVideoOperationName(data.operationName);
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Working on your video...` }]);
      }
    });

    newSocket.on('gemini_get_video_status_response', (data: any) => {
      if (data.error) {
        setGeminiLoading(false);
        setVideoOperationName(null);
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Error generating video: ${data.error}` }]);
      } else if (data.done) {
        setGeminiLoading(false);
        setVideoOperationName(null);
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Video generated successfully! [File: ${data.filepath}]`, mediaUrl: data.url, mediaType: 'video' }]);
        autoCanvasRef.current(fromMedia('video', data.url, String(data.filepath || 'video').split('/').pop() || 'video', 'Milla', 'sandbox'));
      }
    });

    newSocket.on('canvas_revise_response', (data: any) => {
      setCanvasRevising(false);
      if (data.error) setGeminiChatHistory(prev => [...prev, { role: 'model', content: `I couldn't revise it: ${data.error}` }]);
      else {
        openInCanvasRef.current(data.code, `revised: ${String(data.request || '').slice(0, 40)}`);
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Done. The revision is a new version in the canvas.` }]);
      }
    });

    newSocket.on('gemini_generate_code_response', (data: any) => {
      setGeminiLoading(false);
      if (data.error) {
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Error generating app: ${data.error}` }]);
      } else {
        openInCanvasRef.current(data.code, 'Generate App');
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Built it. It's open in the canvas above. [File: ${data.filepath}]` }]);
      }
    });

    return () => {
      newSocket.close();
      unsubscribeVfs();
      unsubscribeHistory();
    };
  }, [user, isAuthReady]);

  useEffect(() => {
    if (!videoOperationName || !socket) return;
    
    const interval = setInterval(() => {
      socket.emit('gemini_get_video_status', { 
        operationName: videoOperationName,
        prompt: geminiChatHistory[geminiChatHistory.length - 1]?.content || ''
      });
    }, 4000);

    return () => clearInterval(interval);
  }, [videoOperationName, socket, geminiChatHistory]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  useEffect(() => {
    if (!showSettings) return;
    const url = (apiKeys.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    let cancelled = false;
    fetch(`${url}/api/tags`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        const names = Array.from(new Set<string>(
          (data.models || []).map((m: { name?: string }) => m.name).filter((name: string | undefined): name is string => !!name)
        ));
        setOllamaModels(names);
        setOllamaModelError('');
      })
      .catch(() => {
        if (cancelled) return;
        setOllamaModels([]);
        setOllamaModelError('Could not list models from that URL. Ollama has to be running, and this page has to be allowed (OLLAMA_ORIGINS=*). You can still type a model name.');
      });
    return () => { cancelled = true; };
  }, [showSettings, apiKeys.ollamaUrl]);

  const handleCommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !socket) return;

    const trimmedInput = input.trim();
    setCommandHistory(prev => [...prev, trimmedInput]);
    setHistoryIndex(-1);
    setPrediction('');

    if (trimmedInput === 'clear') {
      setHistory([]);
      setInput('');
      return;
    }

    const [command, ...args] = trimmedInput.split(' ');

    if (command === 'set-boot') {
      const target = args[0];
      if (!target) return;
      let urlToSave = target;
      if (target.startsWith('/')) {
        const node = vfs[target];
        if (node && node.type === 'file' && node.content) {
          urlToSave = node.content;
        } else {
          setHistory(prev => [...prev, { id: Date.now().toString(), type: 'error', text: `File not found in VFS: ${target}` }]);
          setInput('');
          return;
        }
      }
      
      try {
        localStorage.setItem('aetherterm_boot_video', urlToSave);
        setBootVideo(urlToSave);
        setHistory(prev => [...prev, { id: Date.now().toString(), type: 'output', text: `Boot video updated successfully. It will play on the next reload.` }]);
      } catch (err) {
        setHistory(prev => [...prev, { id: Date.now().toString(), type: 'error', text: `Failed to save boot video. The file is likely too large for local storage (limit ~5MB). Try a smaller file or an external URL.` }]);
      }
      
      setInput('');
      return;
    }

    const text = (command === 'ask' && defaultLlm === 'local')
      ? `local-ask ${args.join(' ')}`
      : trimmedInput;
    socket.emit('input', { text });
    setInput('');
    socket?.emit('input_change', { text: '', timestamp: Date.now() });
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !socket) return;

    socket.emit('chat_message', {
      message: chatInput.trim()
    });
    setChatInput('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);
    socket?.emit('input_change', { text: val, timestamp: Date.now() });
    if (!val) {
      setPrediction('');
      return;
    }

    const parts = val.split(' ');
    if (parts.length === 1) {
      const match = ALL_COMMANDS.find(c => c.startsWith(val));
      setPrediction(match ? match : '');
    } else {
      const lastPart = parts[parts.length - 1];
      const paths = Object.keys(vfs);
      const match = paths.find(p => p.startsWith(lastPart));
      if (match) {
        parts[parts.length - 1] = match;
        setPrediction(parts.join(' '));
      } else {
        setPrediction('');
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (prediction) {
        setInput(prediction);
        socket?.emit('input_change', { text: prediction, timestamp: Date.now() });
        setPrediction('');
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        const txt = commandHistory[commandHistory.length - 1 - newIndex];
        setInput(txt);
        socket?.emit('input_change', { text: txt, timestamp: Date.now() });
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        const txt = commandHistory[commandHistory.length - 1 - newIndex];
        setInput(txt);
        socket?.emit('input_change', { text: txt, timestamp: Date.now() });
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInput('');
        socket?.emit('input_change', { text: '', timestamp: Date.now() });
      }
    }
  };

  const toggleVoiceCommand = () => {
    if (isListening) return;
    
    // @ts-ignore - Web Speech API
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setHistory(prev => [...prev, { id: Date.now().toString(), type: 'error', text: 'Speech recognition is not supported in this browser.' }]);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => setIsListening(true);
    
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInput(transcript.toLowerCase().replace(/[.,?!]/g, ''));
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error', event.error);
      setIsListening(false);
    };

    recognition.onend = () => setIsListening(false);
    
    recognition.start();
  };

  const renderHistoryEntry = (entry: HistoryEntry) => {
    const resolveUrl = (url?: string) => {
      if (!url) return '';
      if (url.startsWith('/') && vfs[url] && vfs[url].content) {
        return vfs[url].content;
      }
      return url;
    };

    switch (entry.type) {
      case 'command':
        return <div key={entry.id} className="text-glow-400 font-bold">{entry.text}</div>;
      case 'output':
        if ((entry as any).isChat) {
          const isMe = (entry as any).sender === (user ? (user.displayName || user.email?.split('@')[0]) : 'Danny');
          const isMilla = (entry as any).sender === 'Milla';
          return (
            <div key={entry.id} className={`my-2 flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              <div className={`p-3 rounded-lg max-w-[85%] sm:max-w-md ${
                isMe
                  ? 'bg-brand-950/40 text-brand-200 border border-brand-500/30'
                  : isMilla
                    ? 'bg-milla-950/40 text-milla-100 border border-milla-500/30'
                    : 'bg-glow-950/30 text-glow-200 border border-glow-500/20'
              }`}>
                <div className="flex items-center justify-between gap-4 mb-1 border-b border-bright/5 pb-1">
                  <span className={`text-[10px] uppercase font-bold tracking-wider ${isMe ? 'text-brand-400' : isMilla ? 'text-milla-300' : 'text-glow-400'}`}>
                    {(entry as any).sender || 'Anonymous'}
                  </span>
                  <span className="text-[9px] text-ink-500 font-mono">
                    {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
                <div className="text-sm break-words whitespace-pre-wrap">{entry.text}</div>
              </div>
            </div>
          );
        }
        if ((entry as any).mediaUrl) {
          const mu = resolveUrl((entry as any).mediaUrl);
          return (
            <div key={entry.id} className="my-2">
              {entry.text && <div className="text-ink-300 whitespace-pre-wrap mb-1">{entry.text}</div>}
              {(entry as any).mediaType === 'image'
                ? <img src={mu} alt="" className="max-w-md rounded border border-ink-700" referrerPolicy="no-referrer" />
                : <VideoPlayer url={mu} pip={(entry as any).mediaType === 'pip'} />}
            </div>
          );
        }
        return <div key={entry.id} className={`${(entry as any).isError ? 'text-danger-400' : 'text-ink-300'} whitespace-pre-wrap`}>{entry.text}</div>;
      case 'error':
        return <div key={entry.id} className="text-danger-400">{entry.text}</div>;
      case 'image':
        return (
          <div key={entry.id} className="my-2">
            <img src={resolveUrl(entry.url)} alt="Terminal output" className="max-w-md rounded border border-ink-700" referrerPolicy="no-referrer" />
          </div>
        );
      case 'video':
        return (
          <div key={entry.id} className="my-2">
            <VideoPlayer url={resolveUrl(entry.url)} pip={entry.pip} />
          </div>
        );
      case 'sandbox':
        return (
          <div key={entry.id} className="my-2 p-4 border border-brand-500/30 bg-brand-500/10 rounded flex items-center justify-between">
            <div className="flex items-center gap-2 text-brand-300">
              <Code size={18} />
              <span>App Generated Successfully</span>
            </div>
            <button 
              onClick={() => {
                openInCanvas(entry.code!, 'terminal');
              }}
              className="px-3 py-1 bg-brand-600 hover:bg-brand-500 text-bright rounded text-sm transition-colors"
            >
              Open Sandbox
            </button>
          </div>
        );
      default:
        return null;
    }
  };

  if (!isAuthReady) {
    return <div className="flex h-screen bg-surface-0 items-center justify-center text-glow-400 font-mono">Initializing Systems...</div>;
  }

  return (
    <div className="flex h-screen bg-surface-0 text-ink-200 font-mono overflow-hidden relative">
      {/* Boot Screen */}
      <AnimatePresence>
        {isBooting && (
          <motion.div 
            className="absolute inset-0 z-[100] bg-void flex items-center justify-center overflow-hidden"
            exit={{ opacity: 0, scale: 1.05 }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
          >
            {!bootStarted ? (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center gap-8"
              >
                <div className="relative">
                  <TerminalIcon size={64} className="text-glow-500 relative z-10" />
                  <div className="absolute inset-0 bg-glow-500 blur-xl opacity-50 animate-pulse" />
                </div>
                <button 
                  onClick={() => setBootStarted(true)}
                  className="px-8 py-3 bg-transparent border border-glow-500/50 text-glow-400 font-bold rounded hover:bg-glow-900/30 hover:border-glow-400 transition-all tracking-[0.2em] flex items-center gap-3 group"
                >
                  <Power size={18} className="group-hover:text-bright transition-colors" />
                  INITIATE BOOT SEQUENCE
                </button>
              </motion.div>
            ) : (
              <div className="relative w-full h-full">
                <video
                  src={bootVideo}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-cover opacity-80"
                  onEnded={() => setIsBooting(false)}
                  onError={(e) => {
                    console.error("Boot video playback failed:", e);
                    setIsBooting(false);
                  }}
                />
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-surface-0 pointer-events-none" />
                
                {/* Scanline effect */}
                <div className="absolute inset-0 pointer-events-none boot-scanlines z-10 opacity-20" />

                <div className="absolute bottom-12 left-0 right-0 flex justify-center z-20">
                  <button 
                    onClick={() => setIsBooting(false)}
                    className="px-6 py-2 bg-void/50 border border-ink-700 text-ink-400 rounded hover:text-bright hover:border-ink-500 transition-colors backdrop-blur-md text-sm tracking-wider"
                  >
                    SKIP SEQUENCE
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Left Sidebar - VFS */}
      <div className="w-64 shrink-0 border-r border-ink-800 bg-surface-1 flex flex-col">
        {(!isDesktop || mode === 'sandbox') && <div className="p-4 border-b border-ink-800 flex items-center justify-between text-glow-400">
          <div className="flex items-center gap-2">
            <Folder size={18} />
            <span className="font-bold tracking-wider" title={isDesktop ? 'Sandbox virtual file system' : undefined}>{isDesktop ? 'SANDBOX FILES' : 'FILE SYSTEM'}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleMountLocal} className="hover:text-glow-300 transition-colors" title={isDesktop ? "Import a copy of a folder into the sandbox VFS" : "Mount Local Folder"}>
              <Folder size={16} />
            </button>
            <button onClick={() => fileInputRef.current?.click()} className="hover:text-glow-300 transition-colors" title="Upload File">
              <Upload size={16} />
            </button>
          </div>
          <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileUpload} />
        </div>}
        {(!isDesktop || mode === 'sandbox') && <div className="flex-1 overflow-y-auto p-4" data-testid="vfs-tree">
          <button type="button" data-testid="explorer-home" data-home={virtualHome}
            title="Home follows the mode: in the Sandbox it is this folder inside the virtual file system"
            onClick={() => socket?.emit('input', { text: 'cd ~' })}
            className="w-full mb-2 px-2 py-1 rounded text-[11px] text-left border border-ink-800 hover:border-glow-500/40 flex items-center gap-1.5">
            <Home size={12} className="text-glow-400 shrink-0" /> <span className="text-ink-400">Home</span> <span className="text-ink-200 truncate">{virtualHome}</span>
          </button>
          {Object.entries(vfs)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, node]: [string, VFSNode]) => {
              const depth = Math.max(0, path.split('/').length - 2);
              const name = path === '/' ? '/' : path.split('/').pop();
              const isHome = path === virtualHome;
              return (
                <div 
                  key={path} 
                  className="flex items-center gap-2 py-1 text-sm hover:text-glow-300 cursor-pointer transition-colors"
                  style={{ paddingLeft: `${depth * 16}px` }}
                  onClick={() => {
                    if (node.type === 'file') {
                      // File preview in the canvas (kept as a version; the editor stays in front).
                      const c = node.content || '';
                      autoCanvas(fromFile(path, c, { url: /^(data:|https?:)/.test(c) ? c : undefined, origin: 'sandbox' }));
                      setEditorFile(path);
                      setEditorContent(node.content || '');
                      setRightPanel('editor');
                    }
                  }}
                >
                  {isHome ? <Home size={14} className="text-glow-400 shrink-0" /> : (node.type === 'dir' || (node as any).type === 'directory') ? <Folder size={14} className="text-folder-500 shrink-0" /> : <File size={14} className="text-ink-400 shrink-0" />}
                  <span className="truncate">{name}{isHome ? ' (~)' : ''}</span>
                </div>
              );
          })}
        </div>}
        <LocalExplorer />
        <div className="p-4 border-t border-ink-800 flex items-center justify-between text-sm">
          <div className="flex items-center gap-2 text-ink-400">
            <Users size={14} />
            <span className="truncate max-w-[150px]">Danny · local</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowSettings(true)} className="text-ink-500 hover:text-glow-400 transition-colors" title="Settings">
              <Settings size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Main Terminal Area. v0.4: the terminal panel below is ALWAYS on screen ("It's the Term in the Aether"):
          Sandbox = the virtual nexus shell, Real = real bash. It never collapses and no panel can cover it. */}
      <div className="flex-1 flex flex-col relative min-w-[380px]" data-testid="main-area">
        <ModeBanner />
        <div className="p-4 border-b border-ink-800 flex items-center justify-between bg-surface-1 flex-wrap gap-2">
          <div className="flex items-center gap-3 text-glow-400 flex-wrap">
            <TerminalIcon size={18} />
            <span className="font-bold tracking-wider">AETHER_TERM v2.0</span>
            <div className="h-4 w-px bg-ink-800" />
            <span className="text-xs text-brand-400 font-mono flex items-center gap-1 bg-brand-950/30 px-2 py-0.5 rounded border border-brand-500/20">
              <Users size={12} />
              Session: <span className="font-bold text-bright uppercase">{sessionId}</span>
            </span>
            <button
              onClick={() => {
                let currentSession = new URLSearchParams(window.location.search).get('session');
                if (!currentSession) {
                  const randomCode = Math.random().toString(36).substring(2, 7);
                  currentSession = randomCode;
                  const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?session=' + randomCode;
                  window.history.pushState({ path: newUrl }, '', newUrl);
                  setSessionId(randomCode);
                  socket?.emit('join', {
                    username: user ? (user.displayName || user.email?.split('@')[0]) : 'Danny',
                    sessionId: randomCode
                  });
                }
                const shareLink = window.location.href;
                navigator.clipboard.writeText(shareLink).then(() => {
                  setHistory(prev => [...prev, { id: Date.now().toString(), type: 'output', timestamp: Date.now(), userId: user?.uid || 'local', text: `[System]: Link copied to clipboard! Share it with collaborators to join room '${currentSession}': ${shareLink}` }]);
                });
              }}
              className="text-[11px] bg-glow-950/50 text-glow-400 hover:bg-glow-900/60 border border-glow-500/30 px-2.5 py-1 rounded transition-colors font-mono flex items-center gap-1"
              title="Copy session link to invite others"
            >
              <Copy size={11} />
              Invite Collaborators
            </button>
          </div>
          <div className="flex items-center gap-2">
            <ModeSwitch />
            <button
              onClick={() => {
                if (rightPanel !== 'gemini-chat') setCanvasUnseen(0);
                setRightPanel(rightPanel === 'gemini-chat' ? null : 'gemini-chat');
              }}
              className={`px-3 py-1 rounded text-xs transition-all flex items-center gap-1.5 font-mono ${rightPanel === 'gemini-chat' ? 'bg-brand-600 hover:bg-brand-500 text-bright shadow-lg shadow-brand-500/20' : 'bg-brand-950/40 text-brand-300 border border-brand-500/30 hover:bg-brand-900/40'}`}
            >
              <Sparkles size={13} className="animate-pulse" />
              Milla Workspace
              {canvasUnseen > 0 && <span className="ml-1 px-1 rounded bg-brand-700 text-bright text-[10px]" data-testid="workspace-unseen">{canvasUnseen}</span>}
            </button>
          </div>
        </div>

        <LocalFilePane />
        <div className="flex-1 min-h-[220px] flex flex-col min-w-0" data-testid="terminal-panel" data-shell={isDesktop && mode === 'real' ? 'real' : 'virtual'}>
        {isDesktop && mode === 'real' ? <RealShell /> : (<>
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-1 min-w-0" data-testid="virtual-shell">
          <div className="text-ok-400 mb-4">
            <pre className="text-xs sm:text-sm leading-tight">
              {renderAscii(asciiArt)}
            </pre>
            <p className="mt-4 text-ink-400">Welcome to <span className="text-brand-400 font-bold">NEXUS RAYNE</span>. Type <span className="text-glow-400">help</span> to see available commands.</p>
            <p className="mt-1 text-ink-500 text-xs">Try: <span className="text-brand-400">view https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjEx.../giphy.gif</span> or <span className="text-brand-400">generate-image a futuristic cyberpunk city</span></p>
          </div>
          
          {history.map(renderHistoryEntry)}
          {millaTyping && <TypingDots />}
          <div ref={bottomRef} />
        </div>

          {/* Terminal Command Input */}
          <form 
            id="terminal-command-form" 
            onSubmit={handleCommand} 
            className="px-4 py-2.5 flex items-center gap-3 relative border-t border-ink-800 bg-surface-1"
          >
            <span className="text-glow-500 font-bold font-mono text-xs sm:text-sm whitespace-nowrap" data-testid="shell-prompt" title={`Home (~) is ${virtualHome} in the Sandbox`}>nexus@rayne:{shellInfo.display}$</span>
            <div className="flex-1 relative flex items-center">
              {prediction && prediction !== input && (
                <span className="absolute left-0 text-ink-600 pointer-events-none whitespace-pre text-xs sm:text-sm font-mono">
                  {input}<span className="opacity-50">{prediction.slice(input.length)}</span>
                </span>
              )}
              <input
                id="terminal-command-input"
                type="text"
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                className="w-full bg-transparent outline-none text-ink-200 placeholder-ink-700 font-mono text-xs sm:text-sm relative z-10"
                placeholder="Enter command (e.g., help, play <url> or click mic)..."
                autoFocus
              />
              {typingUser && (
                <span className="absolute right-2 text-[10px] text-brand-400 font-mono italic animate-pulse bg-brand-950/40 px-2 py-0.5 rounded border border-brand-500/20 z-20">
                  {typingUser} is typing...
                </span>
              )}
            </div>
            <button 
              id="terminal-voice-btn"
              type="button"
              onClick={toggleVoiceCommand}
              className={`p-1.5 rounded transition-colors ${isListening ? 'bg-danger-500/20 text-danger-500 animate-pulse' : 'text-ink-500 hover:text-glow-400 hover:bg-ink-800'}`}
              title="Voice Command"
            >
              {isListening ? <Mic size={16} /> : <MicOff size={16} />}
            </button>

            <button 
              id="terminal-run-btn"
              type="submit"
              className={`p-1.5 rounded transition-all flex items-center justify-center ${input.trim() ? 'text-glow-400 bg-glow-950/30 hover:bg-glow-900/40 border border-glow-500/30' : 'text-ink-500 hover:text-glow-400'}`}
              title="Run Command"
            >
              <Send size={16} />
            </button>
          </form>

        </>)}
        </div>
        <div id="terminal-footer-container" className="bg-surface-1 border-t border-ink-800 flex flex-col">
          {/* Dedicated Chat Input */}
          <form 
            id="terminal-chat-form"
            onSubmit={handleSendChat} 
            className="px-4 py-3 flex items-center gap-3 bg-surface-0"
          >
            <div className="flex items-center gap-1.5 text-brand-400 shrink-0 select-none">
              <Users size={14} />
              <span className="text-[10px] uppercase tracking-wider font-bold text-brand-400/80 font-mono">Chat</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0 text-[10px] text-ink-400 font-mono px-2 py-0.5 rounded border border-ink-800" title="People connected to this terminal">
              <Wifi size={10} className={user ? "text-ok-500" : "text-ink-500"} />
              <span>{onlineUsers.length} Online</span>
            </div>
            <div className="flex-1">
              <input
                id="terminal-chat-input"
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                className="w-full bg-transparent outline-none text-ink-200 placeholder-ink-600 text-xs sm:text-sm"
                placeholder="Message Milla and anyone else in the room..."
              />
            </div>
            <button 
              id="terminal-chat-send-btn"
              type="submit"
              className={`p-1.5 rounded transition-all flex items-center justify-center ${chatInput.trim() ? 'text-brand-400 bg-brand-950/30 hover:bg-brand-900/40 border border-brand-500/30' : 'text-ink-500 hover:text-brand-400'}`}
              title="Send Chat Message"
            >
              <Send size={15} />
            </button>
          </form>
        </div>
      </div>

      {/* Right Sidebar - Sandbox / Editor */}
      <AnimatePresence>
        {rightPanel === 'sandbox' && activeSandbox && (
          <motion.div 
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: '40%', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="border-l border-ink-800 bg-bright flex flex-col overflow-hidden"
          >
            <div className="p-4 bg-surface-1 border-b border-ink-800 flex items-center justify-between text-ink-200">
              <div className="flex items-center gap-2 text-brand-400">
                <Code size={18} />
                <span className="font-bold tracking-wider">SANDBOX</span>
              </div>
              <button 
                onClick={() => setRightPanel(null)}
                className="text-ink-400 hover:text-bright transition-colors"
              >
                <Minimize2 size={18} />
              </button>
            </div>
            <div className="flex-1 bg-bright relative">
              <iframe 
                srcDoc={activeSandbox} 
                className="w-full h-full border-none"
                title="Sandbox"
                sandbox="allow-scripts"
              />
            </div>
          </motion.div>
        )}

        {rightPanel === 'sandbox-monitor' && (
          <motion.div 
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: '40%', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="border-l border-ink-800 bg-surface-1 flex flex-col overflow-hidden"
          >
            <div className="p-4 bg-surface-1 border-b border-ink-800 flex items-center justify-between text-ink-200">
              <div className="flex items-center gap-2 text-glow-400">
                <Shield size={18} className="animate-pulse" />
                <span className="font-bold tracking-wider font-mono text-sm">SANDBOX INTEGRITY AUDITOR</span>
              </div>
              <button 
                onClick={() => setRightPanel(null)}
                className="text-ink-400 hover:text-bright transition-colors"
              >
                <Minimize2 size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-surface-2 md:outline md:outline-1 md:outline-glow-500/10 p-3 rounded flex flex-col justify-between">
                  <span className="text-ink-500 text-[10px] tracking-widest font-mono uppercase">Workspace Storage</span>
                  <span className="text-xl font-bold font-mono text-glow-400 mt-1">{sandboxMetrics.workspaceSize || '0 KB'}</span>
                </div>
                <div className="bg-surface-2 md:outline md:outline-1 md:outline-brand-500/10 p-3 rounded flex flex-col justify-between">
                  <span className="text-ink-500 text-[10px] tracking-widest font-mono uppercase">Security Layer</span>
                  <span className="text-[11px] font-bold font-mono text-brand-400 mt-2 flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-400 animate-ping"></span>
                    JAIL ACTIVE
                  </span>
                </div>
              </div>

              <div className="bg-surface-1 border border-ink-800 p-4 rounded-lg space-y-3 font-mono">
                <div className="flex items-center justify-between text-xs text-ink-400">
                  <span className="flex items-center gap-1"><Cpu size={14} className="text-ok-400" /> Host Isolation boundaries</span>
                  <span className="text-ok-400">256MB / 8s Limit</span>
                </div>
                
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-ink-500">
                    <span>Peak thread CPU utility</span>
                    <span>{sandboxMetrics.processes.some(p => p.status === 'running') ? '12.4%' : '0.0%'}</span>
                  </div>
                  <div className="w-full bg-ink-900 h-1.5 rounded-full overflow-hidden">
                    <div 
                      className="bg-glow-500 h-full transition-all duration-500" 
                      style={{ width: sandboxMetrics.processes.some(p => p.status === 'running') ? '12.4%' : '0%' }}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-ink-500">
                    <span>VFS workspace memory footprint</span>
                    <span>{sandboxMetrics.workspaceSize} / 50.0 MB</span>
                  </div>
                  <div className="w-full bg-ink-900 h-1.5 rounded-full overflow-hidden">
                    <div 
                      className="bg-brand-500 h-full transition-all duration-500" 
                      style={{ width: '0.8%' }}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-ink-400 text-xs font-bold font-mono uppercase tracking-wider flex items-center gap-1">
                  <Activity size={12} className="text-glow-400" /> Boundary Audit Log
                </h3>
                <div className="bg-void/40 border border-ink-900 p-3 rounded font-mono text-[11px] space-y-1 text-ink-400 max-h-[120px] overflow-y-auto">
                  <div className="text-info-400 select-none">[04:30:12] Auditor: Path traversal restriction armed.</div>
                  <div className="text-brand-400 select-none">[04:30:13] Scheduler: Real-time RSS limits at 256MB peak virtual size.</div>
                  {sandboxMetrics.processes.map((proc, idx) => (
                    <div key={idx} className="text-ink-500">
                      [{new Date(proc.startedAt).toLocaleTimeString()}] Exec: {proc.file.split('/').pop()} (PID: {proc.pid}) status {proc.status.toUpperCase()}
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-bold font-mono text-ink-400 tracking-wider uppercase">
                  <span className="flex items-center gap-1"><Layers size={12} className="text-glow-400" /> Micro-processes</span>
                  <span className="text-[10px] text-ink-500">{sandboxMetrics.processes.filter(p => p.status === 'running').length} Active</span>
                </div>

                <div className="space-y-2">
                  {sandboxMetrics.processes.length === 0 ? (
                    <div className="bg-void/10 border border-dashed border-ink-800 p-6 text-center text-xs text-ink-500 font-mono rounded">
                      No active processes are running.
                    </div>
                  ) : (
                    sandboxMetrics.processes.map((proc) => (
                      <div key={proc.pid} className="bg-surface-2 border border-ink-800 rounded p-3 font-mono text-xs flex items-center justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${proc.status === 'running' ? 'bg-ok-500 animate-pulse' : proc.status === 'completed' ? 'bg-glow-500' : 'bg-danger-500'}`} />
                            <span className="font-bold text-ink-300">{proc.file.split('/').pop()}</span>
                            <span className="text-ink-500 text-[10px]">(PID: {proc.pid})</span>
                          </div>
                          <div className="text-[10px] text-ink-500 flex items-center gap-2">
                            <span>Status: <span className="text-ink-400">{proc.status}</span></span>
                            <span>•</span>
                            <span>CPU: <span className="text-ink-400">{proc.cpu}%</span></span>
                            <span>•</span>
                            <span>Mem: <span className="text-ink-400">{proc.memory.toFixed(1)}MB</span></span>
                          </div>
                        </div>

                        {proc.status === 'running' && (
                          <button
                            onClick={() => socket?.emit('sandbox_kill', { pid: proc.pid })}
                            className="p-1 px-2 text-[10px] bg-danger-950 text-danger-400 border border-danger-900/40 rounded hover:bg-danger-900 hover:text-danger-200 transition-colors flex items-center gap-1"
                            title="Force Kill Process"
                          >
                            <StopCircle size={10} /> Kill
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="border-t border-ink-900 pt-4 flex gap-2">
                <button
                  onClick={() => socket?.emit('sandbox_reset')}
                  className="flex-1 py-1.5 bg-ink-900 hover:bg-ink-850 text-ink-300 border border-ink-800 hover:border-ink-700 rounded text-xs transition-colors flex items-center justify-center gap-1.5 font-mono"
                >
                  <RefreshCw size={12} /> Purge Test VFS
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {rightPanel === 'editor' && editorFile && (
          <motion.div 
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: '40%', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="border-l border-ink-800 bg-surface-3 flex flex-col overflow-hidden"
          >
            <div className="p-4 bg-surface-1 border-b border-ink-800 flex items-center justify-between text-ink-200">
              <div className="flex items-center gap-2 text-info-400">
                <FileCode size={18} />
                <span className="font-bold tracking-wider truncate max-w-[120px]">{editorFile.split('/').pop()}</span>
              </div>
              <div className="flex items-center gap-2">
                {(editorFile.endsWith('.html') || editorFile.endsWith('.htm')) && (
                  <button 
                    onClick={() => {
                      socket?.emit('save_file', { path: editorFile, content: editorContent, vfs });
                      openInCanvas(editorContent, `VFS ${editorFile}`, editorFile.split('/').pop());
                    }}
                    className="px-2.5 py-1 bg-brand-600 hover:bg-brand-500 text-bright rounded text-xs leading-none transition-colors flex items-center gap-1 font-mono font-medium whitespace-nowrap"
                    title="Live Preview HTML inside Sandbox Iframe"
                  >
                    <Play size={12} />
                    Preview
                  </button>
                )}
                {(editorFile.endsWith('.js') || editorFile.endsWith('.py') || editorFile.endsWith('.sh')) && (
                  <button 
                    onClick={() => {
                      socket?.emit('save_file', { path: editorFile, content: editorContent, vfs });
                      socket?.emit('command', { 
                        command: 'sandbox', 
                        args: ['run', editorFile], 
                        user: user ? (user.displayName || user.email?.split('@')[0]) : 'Danny', 
                        vfs,
                        apiKeys,
                        defaultLlm
                      });
                      setRightPanel('sandbox-monitor');
                    }}
                    className="px-2.5 py-1 bg-ok-600 hover:bg-ok-500 text-bright rounded text-xs leading-none transition-colors flex items-center gap-1 font-mono font-medium whitespace-nowrap"
                    title="Execute script in secure isolated sandbox container"
                  >
                    <Play size={12} />
                    Run
                  </button>
                )}
                <button 
                  onClick={() => {
                    socket?.emit('save_file', { path: editorFile, content: editorContent, vfs });
                  }}
                  className="px-2.5 py-1 bg-info-600 hover:bg-info-500 text-bright rounded text-xs leading-none transition-colors flex items-center gap-1 font-mono font-medium whitespace-nowrap"
                >
                  <Save size={12} />
                  Save
                </button>
                <button 
                  onClick={() => setRightPanel(null)}
                  className="text-ink-400 hover:text-bright transition-colors"
                >
                  <Minimize2 size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 relative flex flex-col">
              <textarea
                value={editorContent}
                onChange={(e) => {
                  const newContent = e.target.value;
                  setEditorContent(newContent);
                  socket?.emit('editor_change', { path: editorFile, content: newContent });
                }}
                className="flex-1 w-full bg-transparent text-ink-300 p-4 font-mono text-sm outline-none resize-none"
                spellCheck={false}
              />
            </div>
          </motion.div>
        )}

        {rightPanel === 'gemini-chat' && (
          <motion.div 
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: canvasOpen && visibleVersions.length ? '55%' : '40%', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className={`border-l border-ink-800 bg-surface-1 flex flex-col overflow-hidden min-w-[300px] ${canvasOpen && visibleVersions.length ? '' : 'max-w-[500px]'}`}
            data-testid="milla-workspace"
          >
            <div className="p-4 bg-surface-1 border-b border-ink-800 flex items-center justify-between text-ink-200">
              <div className="flex items-center gap-2 text-brand-400">
                <Sparkles size={18} className="animate-pulse" />
                <span className="font-bold tracking-wider font-mono text-sm">MILLA AI WORKSPACE</span>
              </div>
              <button 
                onClick={() => setRightPanel(null)}
                className="text-ink-400 hover:text-bright transition-colors"
              >
                <Minimize2 size={18} />
              </button>
            </div>

            {canvasOpen && visibleVersions.length > 0 && (
              <div className="h-[58%] min-h-[260px] flex flex-col">
                <Canvas versions={visibleVersions} setVersions={setVisibleVersions} activeId={canvasActive} setActiveId={setCanvasActive}
                  revising={canvasRevising} onClose={() => setCanvasOpen(false)}
                  follow={canvasFollow} setFollow={setCanvasFollow} unseen={canvasUnseen} onSeen={() => setCanvasUnseen(0)}
                  onRevise={(html, request) => { setCanvasRevising(true); setGeminiChatHistory(prev => [...prev, { role: 'user', content: `Revise the canvas: ${request}` }]); socket?.emit('canvas_revise', { html, request }); }} />
              </div>
            )}
            {!canvasOpen && visibleVersions.length > 0 && (
              <button type="button" onClick={() => setCanvasOpen(true)} className="text-[11px] text-brand-300 bg-surface-2 border-b border-ink-800 py-1 hover:bg-brand-950/40" data-testid="canvas-show">
                Show canvas ({visibleVersions.length} version{visibleVersions.length === 1 ? '' : 's'})
              </button>
            )}
            <div className="p-3 bg-surface-2 border-b border-ink-800 flex gap-1.5 flex-wrap">
              {[
                { id: 'chat', label: 'Conversational', icon: <Bot size={12} /> },
                { id: 'code', label: 'Generate App', icon: <Code size={12} /> },
                { id: 'image', label: 'Text-to-Image', icon: <ImageIcon size={12} /> },
                { id: 'video', label: 'Veo Video', icon: <Video size={12} /> }
              ].map(mode => (
                <button
                  key={mode.id}
                  onClick={() => setGeminiMode(mode.id as any)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-all flex items-center gap-1 ${geminiMode === mode.id ? 'bg-brand-600 text-bright shadow-md' : 'bg-ink-900 text-ink-400 hover:bg-ink-850'}`}
                >
                  {mode.icon}
                  {mode.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {geminiChatHistory.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-4 font-mono select-none">
                  <div className="relative">
                    <Sparkles size={40} className="text-brand-500 animate-pulse" />
                    <div className="absolute inset-0 bg-brand-500 blur-lg opacity-20" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-ink-300 text-sm font-bold">Systems Ready</p>
                    <p className="text-ink-500 text-xs max-w-[280px]">Converse with Milla to generate single-file web applications, cinematic visual graphics, and motion clips.</p>
                  </div>
                </div>
              ) : (
                geminiChatHistory.map((item, idx) => (
                  <div key={idx} className={`flex flex-col space-y-1.5 ${item.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <span className="text-[10px] text-ink-500 uppercase tracking-widest font-mono font-bold">
                      {item.role === 'user' ? 'user' : 'milla'}
                    </span>
                    <div className={`p-3 rounded-lg max-w-[90%] font-mono text-xs whitespace-pre-wrap break-words leading-relaxed ${item.role === 'user' ? 'bg-brand-950 text-brand-200 border border-brand-500/20' : 'bg-surface-2 text-ink-200 border border-ink-800'}`}>
                      {item.content}
                      {item.role === 'model' && htmlFromReply(item.content) && (
                        <button type="button" onClick={() => openInCanvas(htmlFromReply(item.content)!, 'chat reply')} data-testid="open-in-canvas"
                          className="mt-2 block px-2 py-1 rounded bg-brand-800/60 border border-brand-500/40 text-brand-100 text-[11px] hover:bg-brand-700/60">
                          Open in canvas
                        </button>
                      )}
                      {item.mediaUrl && item.mediaType === 'image' && (
                        <div className="mt-3 overflow-hidden rounded border border-ink-800">
                          <img src={item.mediaUrl} alt="Milla generation" className="w-full h-auto object-cover" referrerPolicy="no-referrer" />
                        </div>
                      )}
                      {item.mediaUrl && item.mediaType === 'video' && (
                        <div className="mt-3 overflow-hidden rounded border border-ink-800">
                          <video src={item.mediaUrl} controls className="w-full h-auto object-cover" />
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
              {geminiLoading && <TypingDots />}
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!geminiPrompt.trim() || !socket || geminiLoading) return;
                
                const query = geminiPrompt.trim();
                setGeminiPrompt('');
                setGeminiLoading(true);

                setGeminiChatHistory(prev => [...prev, { role: 'user', content: query }]);

                if (geminiMode === 'chat' && defaultLlm === 'local') {
                  socket.emit('gemini_chat', {
                    message: query,
                    provider: 'local',
                    model: ollamaModel,
                    history: geminiChatHistory.filter(h => !h.mediaUrl).map(h => ({ role: h.role, content: h.content }))
                  });
                } else if (geminiMode === 'chat') {
                  socket.emit('gemini_chat', {
                    message: query,
                    history: geminiChatHistory.filter(h => !h.mediaUrl).map(h => ({ role: h.role, content: h.content }))
                  });
                } else if (geminiMode === 'code') {
                  socket.emit('gemini_generate_code', { prompt: query });
                } else if (geminiMode === 'image') {
                  socket.emit('gemini_generate_image', { prompt: query });
                } else if (geminiMode === 'video') {
                  socket.emit('gemini_generate_video', { prompt: query });
                }
              }}
              className="p-3 border-t border-ink-800 bg-surface-1"
            >
              <div className="flex gap-2">
                <input
                  type="text"
                  value={geminiPrompt}
                  onChange={(e) => setGeminiPrompt(e.target.value)}
                  className="flex-1 bg-void text-ink-200 text-xs font-mono p-2.5 rounded outline-none border border-ink-850 focus:border-brand-500/50"
                  placeholder={
                    geminiMode === 'chat' ? "Converse with Milla..." :
                    geminiMode === 'code' ? "Describe the app to build (e.g., calculator)..." :
                    geminiMode === 'image' ? "Describe image (e.g., cyberpunk street)..." :
                    "Describe video (e.g., a serene lake under sunset)..."
                  }
                />
                <button
                  type="submit"
                  disabled={geminiLoading || !geminiPrompt.trim()}
                  className="bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-bright rounded p-2.5 transition-colors"
                >
                  <Send size={14} />
                </button>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Setup Guide Modal */}
      <AnimatePresence>
        {showSetup && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-void/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-surface-1 border border-glow-500/30 rounded-lg p-6 max-w-2xl w-full shadow-2xl shadow-glow-500/10"
            >
              <div className="flex items-center gap-3 mb-6 border-b border-ink-800 pb-4">
                <TerminalIcon className="text-glow-400" size={28} />
                <h2 className="text-2xl font-bold text-ink-100 tracking-wider">Welcome to NEXUS RAYNE</h2>
              </div>
              
              <div className="space-y-4 text-ink-300 mb-8">
                <p>Nexus Rayne is a collaborative, AI-powered terminal environment. Here's what you can do:</p>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                  <div className="bg-void/50 p-4 rounded border border-ink-800">
                    <h3 className="text-glow-400 font-bold flex items-center gap-2 mb-2"><Code size={16}/> AI Sandbox</h3>
                    <p className="text-sm">Type <code className="text-brand-400">generate-app a neon clock</code> to have Milla build a web app and run it instantly in the side panel.</p>
                  </div>
                  <div className="bg-void/50 p-4 rounded border border-ink-800">
                    <h3 className="text-glow-400 font-bold flex items-center gap-2 mb-2"><Folder size={16}/> Virtual File System</h3>
                    <p className="text-sm">Upload files using the icon on the left, or clone repos with <code className="text-brand-400">github clone octocat/Hello-World</code>.</p>
                  </div>
                  <div className="bg-void/50 p-4 rounded border border-ink-800">
                    <h3 className="text-glow-400 font-bold flex items-center gap-2 mb-2"><Play size={16}/> Rich Media</h3>
                    <p className="text-sm">Play videos inline with <code className="text-brand-400">play &lt;url&gt;</code> or view images with <code className="text-brand-400">view &lt;url&gt;</code>.</p>
                  </div>
                  <div className="bg-void/50 p-4 rounded border border-ink-800">
                    <h3 className="text-glow-400 font-bold flex items-center gap-2 mb-2"><Users size={16}/> Multi-Agent</h3>
                    <p className="text-sm">Ask specialized agents for help: <code className="text-brand-400">agent coder how to reverse a string in python</code>.</p>
                  </div>
                </div>
                
                <div className="text-sm text-ink-500 mt-4 flex items-center gap-2">
                  <CheckCircle2 size={14} className="text-ok-500" />
                  <span>Pro tip: Use the Up/Down arrow keys to cycle through your command history.</span>
                </div>
              </div>

              <div className="flex justify-end">
                <button 
                  onClick={() => {
                    localStorage.setItem('aetherterm_setup_complete', 'true');
                    setShowSetup(false);
                  }}
                  className="px-6 py-2 bg-glow-600 hover:bg-glow-500 text-bright font-bold rounded transition-colors"
                >
                  INITIALIZE SYSTEM
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-void/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-surface-1 border border-ink-800 rounded-lg p-6 max-w-md w-full shadow-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-glow-400 flex items-center gap-2">
                  <Settings size={20} />
                  System Settings
                </h2>
                <button onClick={() => setShowSettings(false)} className="text-ink-500 hover:text-bright">
                  <span className="text-xl">&times;</span>
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-ink-400 mb-1">Default LLM Provider</label>
                  <select 
                    value={defaultLlm}
                    onChange={(e) => {
                      setDefaultLlm(e.target.value);
                      localStorage.setItem('aetherterm_default_llm', e.target.value);
                    }}
                    className="w-full bg-void border border-ink-700 rounded p-2 text-bright focus:border-glow-400 outline-none"
                  >
                    <option value="gemini">Gemini (cloud)</option>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="local">Local (Ollama, default)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-ink-400 mb-1">Ollama model</label>
                  {ollamaModels.length > 0 ? (
                    <select
                      value={ollamaModel}
                      onChange={(e) => {
                        setOllamaModel(e.target.value);
                        localStorage.setItem('aetherterm_ollama_model', e.target.value);
                      }}
                      className="w-full bg-void border border-ink-700 rounded p-2 text-bright focus:border-glow-400 outline-none"
                    >
                      {!ollamaModels.includes(ollamaModel) && ollamaModel && (
                        <option value={ollamaModel}>{ollamaModel}</option>
                      )}
                      {ollamaModels.map((name) => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={ollamaModel}
                      onChange={(e) => {
                        setOllamaModel(e.target.value);
                        localStorage.setItem('aetherterm_ollama_model', e.target.value);
                      }}
                      placeholder="devmilla:latest"
                      className="w-full bg-void border border-ink-700 rounded p-2 text-bright focus:border-glow-400 outline-none text-sm"
                    />
                  )}
                  <p className="text-[10px] text-ink-600 mt-1">
                    Local chat and <span className="text-ink-400">local-ask</span> use this model. Terminal: <span className="text-ink-400">ollama list</span> then <span className="text-ink-400">ollama use name</span>.
                    {ollamaModelError ? ` ${ollamaModelError}` : ''}
                  </p>
                </div>

                <div className="pt-4 border-t border-ink-800">
                  <h3 className="text-sm font-semibold text-ink-300 mb-3">Bring Your Own Key (BYOK)</h3>
                  
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-ink-500 mb-1">OpenAI API Key</label>
                      <input 
                        type="password" 
                        value={apiKeys.openai}
                        onChange={(e) => {
                          setApiKeys(prev => ({ ...prev, openai: e.target.value }));
                          localStorage.setItem('aetherterm_openai_key', e.target.value);
                        }}
                        placeholder="sk-..."
                        className="w-full bg-void border border-ink-700 rounded p-2 text-bright focus:border-glow-400 outline-none text-sm"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-xs text-ink-500 mb-1">Anthropic API Key</label>
                      <input 
                        type="password" 
                        value={apiKeys.anthropic}
                        onChange={(e) => {
                          setApiKeys(prev => ({ ...prev, anthropic: e.target.value }));
                          localStorage.setItem('aetherterm_anthropic_key', e.target.value);
                        }}
                        placeholder="sk-ant-..."
                        className="w-full bg-void border border-ink-700 rounded p-2 text-bright focus:border-glow-400 outline-none text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-ink-500 mb-1">Custom Gemini API Key (Optional)</label>
                      <input 
                        type="password" 
                        value={apiKeys.gemini}
                        onChange={(e) => {
                          setApiKeys(prev => ({ ...prev, gemini: e.target.value }));
                          localStorage.setItem('aetherterm_gemini_key', e.target.value);
                        }}
                        placeholder="AIza..."
                        className="w-full bg-void border border-ink-700 rounded p-2 text-bright focus:border-glow-400 outline-none text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-ink-500 mb-1">Ollama URL (Local)</label>
                      <input 
                        type="text" 
                        value={apiKeys.ollamaUrl}
                        onChange={(e) => {
                          setApiKeys(prev => ({ ...prev, ollamaUrl: e.target.value }));
                          localStorage.setItem('aetherterm_ollama_url', e.target.value);
                        }}
                        placeholder="http://127.0.0.1:11434"
                        className="w-full bg-void border border-ink-700 rounded p-2 text-bright focus:border-glow-400 outline-none text-sm"
                      />
                      <p className="text-[10px] text-ink-600 mt-1">Requires Ollama running locally with OLLAMA_ORIGINS="*"</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="px-4 py-2 bg-glow-600 hover:bg-glow-500 text-bright rounded transition-colors"
                >
                  Save & Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function VideoPlayer({ url, pip }: { url: string, pip?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(true);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    if (pip && videoRef.current) {
      const video = videoRef.current;
      video.addEventListener('loadedmetadata', () => {
        if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
          video.requestPictureInPicture().catch(console.error);
        }
      });
    }
  }, [pip, url]);

  const togglePip = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (error) {
      console.error(error);
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) videoRef.current.pause();
      else videoRef.current.play();
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setProgress((videoRef.current.currentTime / videoRef.current.duration) * 100);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (videoRef.current) {
      const time = (parseFloat(e.target.value) / 100) * videoRef.current.duration;
      videoRef.current.currentTime = time;
      setProgress(parseFloat(e.target.value));
    }
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseFloat(e.target.value);
    setVolume(vol);
    if (videoRef.current) {
      videoRef.current.volume = vol;
      setIsMuted(vol === 0);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
      if (isMuted && volume === 0) setVolume(0.5);
    }
  };

  return (
    <div className="relative group inline-block max-w-md w-full rounded border border-ink-700 bg-void overflow-hidden">
      <video 
        ref={videoRef}
        src={url} 
        autoPlay 
        muted={isMuted}
        playsInline
        onTimeUpdate={handleTimeUpdate}
        onEnded={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onError={(e) => { const err = (e.currentTarget as HTMLVideoElement).error; setFailed(err?.code === 4 ? 'This file or URL could not be played (not found, not allowed, or not a supported format).' : `Playback failed${err?.message ? `: ${err.message}` : '.'}`); }}
        className="w-full h-auto block"
      />
      {failed && <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-danger-300 bg-void/80" data-testid="media-error">{failed}</div>}
      
      {/* Custom Controls Overlay */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-void/90 via-void/60 to-transparent p-3 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-2">
        <input 
          type="range" 
          min="0" 
          max="100" 
          value={progress || 0} 
          onChange={handleSeek} 
          className="w-full h-1 bg-ink-600 rounded-lg appearance-none cursor-pointer accent-glow-400" 
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={togglePlay} className="text-bright hover:text-glow-400 transition-colors">
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <div className="flex items-center gap-2 group/vol">
              <button onClick={toggleMute} className="text-bright hover:text-glow-400 transition-colors">
                {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input 
                type="range" 
                min="0" 
                max="1" 
                step="0.05" 
                value={isMuted ? 0 : volume} 
                onChange={handleVolume} 
                className="w-0 opacity-0 group-hover/vol:w-16 group-hover/vol:opacity-100 transition-all duration-300 h-1 bg-ink-600 rounded-lg appearance-none cursor-pointer accent-glow-400" 
              />
            </div>
          </div>
          <button onClick={togglePip} className="text-bright hover:text-glow-400 transition-colors" title="Picture-in-Picture">
            <Maximize2 size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Neutral "Milla is replying" indicator: three animated dots, no text. */
function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-3 py-2 w-fit rounded-2xl bg-brand-950/40 border border-brand-500/20" aria-label="Milla is replying" data-testid="typing-dots">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-1.5 h-1.5 rounded-full bg-brand-300 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </div>
  );
}
