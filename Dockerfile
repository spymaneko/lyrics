FROM node:20-slim

# Install FFmpeg and Python dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install OpenAI Whisper & yt-dlp globally
RUN pip3 install --no-cache-dir -U openai-whisper yt-dlp --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]