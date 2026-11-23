FROM node:20-slim

# Install FFmpeg system-wide
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of your files (server.js, etc.) into the container
COPY . .

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
