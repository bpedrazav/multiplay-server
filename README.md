# MultiPlay Anime Server

Servidor Node.js para reproducción de anime en MultiPlay PWA.

## Deploy GRATIS en Render.com (5 min)

1. Sube la carpeta `multiplay-server/` a un repo GitHub nuevo
2. Ve a https://render.com → Sign up gratis
3. "New +" → "Web Service"
4. Conecta el repo de GitHub
5. Configuración:
   - Name: multiplay-anime-server
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: **Free**
6. Click "Create Web Service"
7. Copia la URL que te da (ej: https://multiplay-anime-server.onrender.com)

## Conectar con la app

Edita `/js/app.js` línea 4:
```js
const ANIME_SERVER = 'https://TU-URL-AQUI.onrender.com';
```

Luego redespliega la app en Netlify (drag & drop de nuevo).

## Endpoints
- GET /                        → health check
- GET /anime/search?q=naruto   → buscar anime
- GET /anime/info/:id          → info + lista de episodios
- GET /anime/watch/:episodeId  → fuentes de video del episodio
- GET /proxy?url=...           → proxy para evitar CORS
