# Subtitulito — addon de subtítulos en español para Stremio

Busca el subtítulo en inglés en OpenSubtitles, lo traduce al español con Gemini y se lo pasa a Stremio. Cada usuario usa su propia API key gratuita.

## Deploy en Vercel (gratis)

1. Subí esta carpeta a un repo de GitHub.
2. En vercel.com → **Add New → Project** → importá el repo → **Deploy**. No hay que tocar nada.
3. Abrí `https://<tu-proyecto>.vercel.app/configure`.

### Caché compartida (opcional, recomendada)

Sin esto, cada usuario traduce cada capítulo con su propia cuota. Con esto, un capítulo traducido por alguien sale al instante para todos.

1. En el proyecto de Vercel → **Storage** → **Upstash for Redis** → crear la base gratis y conectarla al proyecto.
2. Redeploy. Las variables se cargan solas.

## Uso

1. Entrá a `/configure`, pegá tu API key (gratis en https://aistudio.google.com/apikey) y elegí la variante.
2. **Instalar en Stremio**, o **Copiar link** y pegarlo en el buscador de complementos.
3. Al reproducir, elegí la pista de Subtitulito.

- La primera vez tarda entre 30 segundos y 1 minuto por capítulo.
- Si algo falla (key inválida, cuota agotada, sin subtítulo en inglés), el error aparece como subtítulo en pantalla.
- La key viaja dentro del link del addon. El servidor no la guarda.

## Probar en local

`npm start` y abrí `http://127.0.0.1:7000/configure`.
