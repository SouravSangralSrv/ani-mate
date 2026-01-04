
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration } from '@google/genai';
import { Personality, ChatMessage, VoiceState, SystemAction } from './types';
import { decode, encode, decodeAudioData, createBlob } from './services/audio-utils';

const STORAGE_KEY = 'ani_mate_chat_history';

const CharacterDisplay: React.FC<{ personality: Personality, isSpeaking: boolean, isLocal: boolean }> = ({ personality, isSpeaking, isLocal }) => {
  const images = {
    [Personality.FEMALE]: 'https://static.beebom.com/wp-content/uploads/2025/09/reze.jpg?w=1024',
    [Personality.MALE]: 'https://images.unsplash.com/photo-1613333151422-791753347ad6?q=80&w=800&auto=format&fit=crop'
  };

  return (
    <div className="relative w-full h-[55vh] flex items-center justify-center overflow-hidden rounded-3xl glass neon-border group">
      <div className="scanline" />
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${isLocal ? 'bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.8)]' : 'bg-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.8)]'}`} />
        <span className="text-[10px] font-bold tracking-tighter uppercase text-slate-400">
          {isLocal ? 'Local Mode (Ollama)' : 'Cloud Mode (Gemini)'}
        </span>
      </div>
      <img
        src={images[personality]}
        alt="Anime Assistant"
        className={`h-full w-full object-cover character-float transition-all duration-700 brightness-90 contrast-110 group-hover:scale-105 ${isSpeaking ? 'saturate-150 brightness-110' : ''}`}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent opacity-80" />
      
      {isSpeaking && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex items-end gap-1.5 h-12 z-20">
          {[...Array(8)].map((_, i) => (
            <div 
              key={i} 
              className="w-1.5 bg-violet-400 rounded-full animate-bounce" 
              style={{ 
                height: `${Math.random() * 80 + 20}%`, 
                animationDuration: `${Math.random() * 0.5 + 0.3}s`,
                boxShadow: '0 0 10px rgba(167, 139, 250, 0.5)'
              }} 
            />
          ))}
        </div>
      )}
    </div>
  );
};

const systemToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'searchGoogle',
    parameters: {
      type: Type.OBJECT,
      description: 'Search the web for information.',
      properties: { query: { type: Type.STRING, description: 'The search term' } },
      required: ['query']
    }
  },
  {
    name: 'openYoutube',
    parameters: {
      type: Type.OBJECT,
      description: 'Open YouTube or search for a specific video.',
      properties: { query: { type: Type.STRING, description: 'The video or channel to find' } },
      required: ['query']
    }
  },
  {
    name: 'playMusic',
    parameters: {
      type: Type.OBJECT,
      description: 'Play music from YouTube Music.',
      properties: { query: { type: Type.STRING, description: 'Track or artist name' } },
      required: ['query']
    }
  }
];

export default function App() {
  const [personality, setPersonality] = useState<Personality>(Personality.FEMALE);
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error("Failed to load history", e);
      return [];
    }
  });
  const [voiceState, setVoiceState] = useState<VoiceState>({
    isActive: false,
    isThinking: false,
    isSpeaking: false,
    transcription: ''
  });
  const [inputText, setInputText] = useState('');

  // Persist messages to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);

  // Refs for audio and speech
  const audioContexts = useRef<any>({ input: null, output: null, stream: null, nextStartTime: 0, sources: new Set() });
  const sessionRef = useRef<any>(null);
  const speechRecognition = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, voiceState.transcription]);

  const addMessage = (role: 'user' | 'assistant' | 'system', content: string) => {
    setMessages(prev => [...prev, { role, content, timestamp: Date.now() }]);
  };

  const clearHistory = () => {
    if (confirm("Goshujin-sama, clear all conversation history?")) {
      setMessages([]);
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const handleSystemAction = useCallback((action: SystemAction) => {
    let url = '';
    switch (action.type) {
      case 'search': url = `https://www.google.com/search?q=${encodeURIComponent(action.query)}`; break;
      case 'youtube': url = `https://www.youtube.com/results?search_query=${encodeURIComponent(action.query)}`; break;
      case 'music': url = `https://music.youtube.com/search?q=${encodeURIComponent(action.query)}`; break;
    }
    if (url) window.open(url, '_blank');
    addMessage('system', `Command triggered: ${action.type} "${action.query}"`);
  }, []);

  // Browser-Native Speech Synthesis for Offline Mode
  const speakLocal = (text: string) => {
    if (!window.speechSynthesis) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US'; // Best compatibility for mixed Hindi
    utterance.rate = 1.0;
    utterance.pitch = personality === Personality.FEMALE ? 1.2 : 0.9;
    
    utterance.onstart = () => setVoiceState(prev => ({ ...prev, isSpeaking: true }));
    utterance.onend = () => setVoiceState(prev => ({ ...prev, isSpeaking: false }));
    window.speechSynthesis.speak(utterance);
  };

  // Local Ollama Request
  const queryOllama = async (prompt: string) => {
    try {
      const response = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama3.2:3b-instruct-q4_K_',
          messages: [{ role: 'system', content: `You are ${personality === Personality.FEMALE ? 'Yuna' : 'Hiro'}, an anime assistant. Speak in Hinglish (English+Hindi). You can suggest searching Google or playing music. Current personality: ${personality}` }, { role: 'user', content: prompt }],
          stream: false
        })
      });
      const data = await response.json();
      const content = data.message.content;
      addMessage('assistant', content);
      speakLocal(content);
      
      // Simple keyword detection for offline mode "system tools"
      if (content.toLowerCase().includes('search')) {
         const match = content.match(/search (.*)/i);
         if (match) handleSystemAction({ type: 'search', query: match[1] });
      }
    } catch (err) {
      addMessage('system', "Offline Error: Make sure Ollama is running locally on port 11434.");
    }
  };

  const startVoice = async () => {
    if (isLocalMode) {
      // Browser Native Speech Recognition
      const Recognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      if (!Recognition) return alert("Browser does not support speech recognition.");
      
      const rec = new Recognition();
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = 'en-US';
      
      rec.onstart = () => setVoiceState(prev => ({ ...prev, isActive: true }));
      rec.onresult = (e: any) => {
        const transcript = Array.from(e.results).map((r: any) => r[0].transcript).join('');
        setVoiceState(prev => ({ ...prev, transcription: transcript }));
      };
      rec.onend = () => {
        setVoiceState(prev => {
          if (prev.transcription) {
            addMessage('user', prev.transcription);
            queryOllama(prev.transcription);
          }
          return { ...prev, isActive: false, transcription: '' };
        });
      };
      rec.start();
      speechRecognition.current = rec;
      return;
    }

    // Cloud Mode (Gemini Live API)
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const inputAC = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputAC = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      audioContexts.current = { input: inputAC, output: outputAC, stream, nextStartTime: 0, sources: new Set() };

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            const source = inputAC.createMediaStreamSource(stream);
            const scriptProcessor = inputAC.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              sessionPromise.then(s => s.sendRealtimeInput({ media: createBlob(e.inputBuffer.getChannelData(0)) }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAC.destination);
            setVoiceState(prev => ({ ...prev, isActive: true }));
          },
          onmessage: async (msg) => {
            const audioData = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              setVoiceState(prev => ({ ...prev, isSpeaking: true }));
              const buffer = await decodeAudioData(decode(audioData), outputAC, 24000, 1);
              const source = outputAC.createBufferSource();
              source.buffer = buffer;
              source.connect(outputAC.destination);
              audioContexts.current.nextStartTime = Math.max(audioContexts.current.nextStartTime, outputAC.currentTime);
              source.start(audioContexts.current.nextStartTime);
              audioContexts.current.nextStartTime += buffer.duration;
              audioContexts.current.sources.add(source);
              source.onended = () => {
                audioContexts.current.sources.delete(source);
                if (audioContexts.current.sources.size === 0) setVoiceState(prev => ({ ...prev, isSpeaking: false }));
              };
            }
            if (msg.serverContent?.outputTranscription) {
              setVoiceState(prev => ({ ...prev, transcription: prev.transcription + msg.serverContent!.outputTranscription!.text }));
            }
            if (msg.serverContent?.turnComplete) {
              setVoiceState(prev => {
                if (prev.transcription) addMessage('assistant', prev.transcription);
                return { ...prev, transcription: '' };
              });
            }
            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                let type: 'search' | 'youtube' | 'music' = 'search';
                if (fc.name === 'openYoutube') type = 'youtube';
                if (fc.name === 'playMusic') type = 'music';
                handleSystemAction({ type, query: fc.args.query as string });
                sessionPromise.then(s => s.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "Success" } } }));
              }
            }
          },
          onclose: () => setVoiceState(prev => ({ ...prev, isActive: false }))
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `You are ${personality === Personality.FEMALE ? 'Yuna' : 'Hiro'}. Speak Hinglish. Use cute anime sounds. Help with searches and music.`,
          tools: [{ functionDeclarations: systemToolDeclarations }],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: personality === Personality.FEMALE ? 'Kore' : 'Puck' } } }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (e) {
      console.error(e);
      alert("Error starting Cloud Session. Ensure API Key is valid.");
    }
  };

  const stopVoice = () => {
    if (isLocalMode) {
      speechRecognition.current?.stop();
    } else {
      audioContexts.current.stream?.getTracks().forEach((t: any) => t.stop());
      sessionRef.current?.close();
    }
    setVoiceState(prev => ({ ...prev, isActive: false, isSpeaking: false }));
  };

  const handleSendText = async () => {
    if (!inputText.trim()) return;
    const msg = inputText;
    setInputText('');
    addMessage('user', msg);
    
    setVoiceState(prev => ({ ...prev, isThinking: true }));
    if (isLocalMode) {
      await queryOllama(msg);
      setVoiceState(prev => ({ ...prev, isThinking: false }));
    } else {
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: msg,
          config: {
            systemInstruction: `You are ${personality === Personality.FEMALE ? 'Yuna' : 'Hiro'}. Assist in Hinglish. Use system tools if needed.`,
            tools: [{ functionDeclarations: systemToolDeclarations }]
          }
        });
        if (response.functionCalls) {
          response.functionCalls.forEach(fc => {
             let type: 'search' | 'youtube' | 'music' = 'search';
             if (fc.name === 'openYoutube') type = 'youtube';
             if (fc.name === 'playMusic') type = 'music';
             handleSystemAction({ type, query: fc.args.query as string });
          });
        }
        addMessage('assistant', response.text || "Processed.");
      } catch (err) {
        addMessage('system', "Error communicating with Gemini.");
      } finally {
        setVoiceState(prev => ({ ...prev, isThinking: false }));
      }
    }
  };

  // Initial greeting if no messages
  useEffect(() => {
    if (messages.length === 0) {
      addMessage('assistant', `Namaste! I am your ${personality === Personality.FEMALE ? 'Yuna' : 'Hiro'}. Main aapki system commands ya music search karne me help kar sakti hoon! Speak to me or type below.`);
    }
  }, []);

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8 flex flex-col md:flex-row gap-8">
      {/* Left: Personality & Control */}
      <div className="w-full md:w-1/2 flex flex-col gap-6">
        <div className="flex items-center justify-between p-4 glass rounded-3xl border-violet-500/20 shadow-2xl">
          <div>
            <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-violet-400 to-pink-500">ANI-MATE</h1>
            <p className="text-[10px] text-slate-500 tracking-[0.2em] uppercase font-semibold">Virtual System Assistant</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="flex gap-2 bg-slate-900/50 p-1 rounded-xl border border-white/5">
              <button onClick={() => setPersonality(Personality.FEMALE)} className={`px-4 py-2 rounded-lg text-xs transition-all ${personality === Personality.FEMALE ? 'bg-violet-600 shadow-lg text-white' : 'text-slate-500 hover:text-white'}`}>YUNA</button>
              <button onClick={() => setPersonality(Personality.MALE)} className={`px-4 py-2 rounded-lg text-xs transition-all ${personality === Personality.MALE ? 'bg-violet-600 shadow-lg text-white' : 'text-slate-500 hover:text-white'}`}>HIRO</button>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <span className={`text-[10px] ${!isLocalMode ? 'text-cyan-400' : 'text-slate-500'}`}>CLOUD</span>
              <button 
                onClick={() => setIsLocalMode(!isLocalMode)}
                className={`w-10 h-5 rounded-full relative transition-colors ${isLocalMode ? 'bg-orange-600' : 'bg-slate-700'}`}
              >
                <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${isLocalMode ? 'right-1' : 'left-1'}`} />
              </button>
              <span className={`text-[10px] ${isLocalMode ? 'text-orange-400' : 'text-slate-500'}`}>LOCAL</span>
            </div>
          </div>
        </div>

        <CharacterDisplay personality={personality} isSpeaking={voiceState.isSpeaking} isLocal={isLocalMode} />

        <div className="p-8 glass rounded-3xl flex flex-col items-center gap-4 relative overflow-hidden group">
          <div className="absolute inset-0 bg-violet-600/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <button 
            onClick={voiceState.isActive ? stopVoice : startVoice}
            className={`w-24 h-24 rounded-full flex items-center justify-center transition-all duration-500 z-10 ${voiceState.isActive ? 'bg-red-500 shadow-[0_0_30px_rgba(239,68,68,0.5)] scale-110' : 'bg-violet-600 hover:bg-violet-500 shadow-[0_0_30px_rgba(139,92,246,0.3)]'}`}
          >
            <i className={`fas ${voiceState.isActive ? 'fa-square' : 'fa-microphone'} text-3xl text-white`} />
          </button>
          <div className="text-center z-10">
            <h3 className="font-bold text-slate-100">{voiceState.isActive ? 'LISTENING...' : 'PUSH TO START'}</h3>
            <p className="text-xs text-slate-500 uppercase tracking-widest mt-1">
              {isLocalMode ? 'Using Local Ollama (Free & Offline)' : 'Using Gemini Cloud (Free Tier)'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <button onClick={() => handleSystemAction({ type: 'music', query: 'japanese lofi' })} className="p-4 glass rounded-2xl flex items-center justify-center gap-3 hover:bg-white/5 transition-all">
            <i className="fas fa-play text-violet-400" /> <span className="text-xs font-bold uppercase tracking-widest">Anime Music</span>
          </button>
          <button onClick={() => handleSystemAction({ type: 'youtube', query: 'vtube highlights' })} className="p-4 glass rounded-2xl flex items-center justify-center gap-3 hover:bg-white/5 transition-all">
            <i className="fab fa-youtube text-red-500" /> <span className="text-xs font-bold uppercase tracking-widest">YouTube</span>
          </button>
        </div>
      </div>

      {/* Right: Interface */}
      <div className="w-full md:w-1/2 flex flex-col h-[85vh] glass rounded-[2.5rem] border border-white/5 shadow-2xl overflow-hidden">
        <div className="px-8 py-6 border-b border-white/5 bg-slate-900/30 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${voiceState.isActive ? 'bg-green-500 animate-pulse' : 'bg-slate-700'}`} />
            <h2 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400">Terminal Log</h2>
          </div>
          <div className="flex items-center gap-4">
            {voiceState.isThinking && <div className="text-[10px] text-violet-400 font-bold animate-pulse">SYSTEM_PROCESSING...</div>}
            <button 
              onClick={clearHistory}
              className="text-[10px] text-slate-500 hover:text-red-400 transition-colors uppercase font-bold tracking-widest"
              title="Clear Chat History"
            >
              <i className="fas fa-trash-alt mr-1" /> Clear
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-6 scroll-smooth">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] p-5 rounded-3xl ${m.role === 'user' ? 'bg-violet-600 text-white shadow-xl shadow-violet-900/20' : m.role === 'system' ? 'bg-slate-800/50 border border-slate-700 text-slate-400 font-mono text-[11px]' : 'bg-slate-800 border border-white/5 text-slate-200 shadow-xl'}`}>
                {m.role === 'system' && <span className="text-violet-400 mr-2">>></span>}
                <p className="text-sm leading-relaxed">{m.content}</p>
                <div className="text-[9px] opacity-40 mt-2 font-mono">{new Date(m.timestamp).toLocaleTimeString()}</div>
              </div>
            </div>
          ))}
          {voiceState.transcription && (
            <div className="flex justify-end">
              <div className="bg-violet-500/20 border border-dashed border-violet-500/50 p-4 rounded-3xl animate-pulse">
                <p className="text-sm text-violet-300 italic">"{voiceState.transcription}"</p>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="p-8 bg-slate-900/50 border-t border-white/5">
          <div className="relative flex items-center gap-3">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendText()}
              placeholder={isLocalMode ? "Local command (Ollama)..." : "Cloud command (Gemini)..."}
              className="flex-1 bg-slate-950/80 border border-white/10 rounded-2xl px-6 py-4 text-sm focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/50 transition-all text-slate-200"
            />
            <button 
              onClick={handleSendText}
              disabled={voiceState.isThinking || !inputText.trim()}
              className="w-14 h-14 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-800 disabled:text-slate-600 rounded-2xl flex items-center justify-center transition-all shadow-lg shadow-violet-900/20"
            >
              <i className="fas fa-location-arrow" />
            </button>
          </div>
          <div className="flex justify-between mt-4 px-1">
            <span className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Model: {isLocalMode ? 'LLama 3.2 3B' : 'Gemini 3 Flash'}</span>
            <span className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Status: {navigator.onLine ? 'ONLINE' : 'OFFLINE'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
