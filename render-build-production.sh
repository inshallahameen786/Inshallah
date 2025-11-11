#!/bin/bash
set -e

echo "=========================================="
echo "🚀 DHA Digital Services - RENDER BUILD"
echo "=========================================="
echo "Build started: $(date)"
echo ""

# Error handler
handle_error() {
  echo ""
  echo "=========================================="
  echo "❌ BUILD FAILED at line $1"
  echo "=========================================="
  exit 1
}

trap 'handle_error $LINENO' ERR

# Environment setup
echo "📌 Setting up environment..."
export NODE_ENV=production
export VITE_MODE=production
export CI=true
export NODE_OPTIONS=--max-old-space-size=4096

# Print versions
echo "Required Node.js version: 20.19.0"
echo "Required npm version: 10.5.0"
echo "Current Node.js version: $(node --version)"
echo "Current npm version: $(npm --version)"

# Verify Node.js version compatibility
node_version=$(node --version | cut -d 'v' -f2)
if [[ "$node_version" != "20.19.0"* ]]; then
    echo "⚠️ Warning: Node.js version mismatch. Required: 20.19.0, Current: $node_version"
    if [[ -n "$CI" ]]; then
        echo "Running in CI environment, continuing anyway..."
    fi
fi

# Install types
npm install --save-dev @types/node@20.11.0 @types/express@4.17.21 @types/cors@2.8.17 @types/compression@1.7.5 @types/helmet@4.0.0

echo "Node version: $(node --version)"
echo "NPM version: $(npm --version)"
echo "Working directory: $(pwd)"
echo ""

# Clean previous builds
echo "🧹 Cleaning previous builds..."
rm -rf dist client/dist node_modules/.cache client/node_modules/.vite || true
echo "✅ Cleaned"
echo ""

# Version check function
check_version() {
  if [[ "$1" != "$2" ]]; then
    echo "⚠️ Version mismatch: Expected $2, got $1"
    echo "⚠️ Continuing anyway (Render manages Node versions)"
  fi
}

# Verify versions
echo "Verifying Node.js and npm versions..."
node_version=$(node --version | cut -d 'v' -f2)
npm_version=$(npm --version)
check_version "$node_version" "20.19.0"
# Don't enforce npm version check - npm comes with Node

# Verify critical files exist
echo "🔍 Verifying critical files..."
for file in package.json tsconfig.production.json client/package.json render.yaml; do
  if [[ ! -f "$file" ]]; then
    handle_error ${LINENO} "Missing critical file: $file"
  fi
done
echo "✅ Critical files verified"

# Install root dependencies
echo "📦 Installing dependencies..."
export NPM_CONFIG_PRODUCTION=false
npm install --no-audit --legacy-peer-deps --prefer-offline || {
    echo "First install failed, retrying with clean install..."
    rm -rf node_modules package-lock.json
    npm install --no-audit --legacy-peer-deps --no-optional
}
echo "✅ Root dependencies installed"
echo ""

# Build client
echo "=========================================="
echo "🎨 BUILDING CLIENT"
echo "=========================================="

cd client || {
  echo "❌ Failed to enter client directory"
  exit 1
}

echo "Current directory: $(pwd)"
echo ""

echo "📦 Installing client dependencies (including dev tools)..."
npm ci --legacy-peer-deps || npm install --legacy-peer-deps --no-audit
echo "✅ Client dependencies installed"
echo ""

echo "🧹 Clearing Vite cache..."
rm -rf node_modules/.vite || true
echo "✅ Cache cleared"
echo ""

echo "🏗️ Building client application..."
NODE_OPTIONS="--max-old-space-size=2048" npm run build || {
  echo "⚠️ First build attempt failed, trying with reduced memory..."
  NODE_OPTIONS="--max-old-space-size=1536" npm run build || {
    echo "❌ Client build failed"
    exit 1
  }
}
echo "✅ Client build complete"
echo ""

echo "🔍 Verifying client build..."
if [ ! -f "dist/index.html" ]; then
  echo "❌ Client build failed - index.html not found"
  echo "Contents of client directory:"
  ls -la . || true
  echo "Contents of dist directory (if exists):"
  ls -la dist || true
  exit 1
fi

echo "✅ Client build successful"
echo "Client build contents:"
ls -la dist/ | head -10
echo ""

# Return to root
cd .. || {
  echo "❌ Failed to return to root directory"
  exit 1
}

echo "=========================================="
echo "⚙️  BUILDING SERVER"
echo "=========================================="

echo "Current directory: $(pwd)"
echo ""

# Create production TypeScript config if needed
if [ ! -f "tsconfig.production.json" ]; then
  echo "⚙️  Creating production TypeScript config..."
  cat > tsconfig.production.json << 'TSCONFIG'
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "sourceMap": false,
    "declaration": false,
    "skipLibCheck": true,
    "noEmitOnError": false,
    "allowJs": true,
    "checkJs": false,
    "resolveJsonModule": true,
    "moduleResolution": "node",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "module": "ESNext",
    "target": "ES2020",
    "outDir": "dist"
  },
  "include": ["server/**/*", "shared/**/*"],
  "exclude": ["node_modules", "client", "**/*.test.ts", "**/*.spec.ts"]
}
TSCONFIG
  echo "✅ Created tsconfig.production.json"
fi

echo "🏗️  Compiling TypeScript..."
echo "Verifying TypeScript installation..."
if [ ! -f "./node_modules/.bin/tsc" ]; then
    echo "Installing TypeScript..."
    npm install --no-save typescript@^5.9.3
fi

echo "Running TypeScript compiler with relaxed checks..."
./node_modules/.bin/tsc -p tsconfig.production.json --skipLibCheck --noEmitOnError false --noUnusedLocals false --noUnusedParameters false 2>&1 | tee /tmp/tsc-errors.log || true

if grep -q "error TS" /tmp/tsc-errors.log; then
    echo "⚠️  TypeScript errors detected - review logs above"
fi

echo "✅ TypeScript compilation completed (warnings ignored)"

# Now do the actual compilation (without --noEmit)
./node_modules/.bin/tsc -p tsconfig.production.json --skipLibCheck || {
  echo "❌ TypeScript compilation failed critically"
  exit 1
}
echo "✅ Server compiled"
echo ""

# Create public directory and copy client build
echo "📋 Setting up public assets..."
mkdir -p dist/public
cp -r client/dist/* dist/public/ || {
  echo "❌ Failed to copy client build to dist/public"
  exit 1
}
echo "✅ Assets copied"
echo ""

# Ensure environment configs are in place
echo "🔧 Ensuring environment configuration..."
bash scripts/ensure-env.sh
echo "✅ Environment configuration ready"
echo ""

# Verify build outputs
echo "=========================================="
echo "🔍 VERIFYING BUILD"
echo "=========================================="

echo "Checking for server entry point..."
if [ ! -f "dist/server/index-minimal.js" ]; then
  echo "❌ Server build failed - dist/server/index-minimal.js not found"
  echo "Contents of dist directory:"
  ls -la dist || true
  echo "Contents of dist/server (if exists):"
  ls -la dist/server || true
  exit 1
fi
echo "✅ Server entry point exists"

echo "Checking for client build..."
if [ ! -f "dist/public/index.html" ]; then
  echo "❌ Client build failed - dist/public/index.html not found"
  echo "Contents of dist/public:"
  ls -la dist/public || true
  exit 1
fi
echo "✅ Client build exists"

echo "Checking for environment configuration..."
if [ ! -f "dist/server/config/env.js" ]; then
  echo "❌ Environment configuration not found"
  echo "Contents of dist/server/config:"
  ls -la dist/server/config || true
  exit 1
fi
echo "✅ Environment configuration exists"
echo ""
echo ""

# Build summary
echo "=========================================="
echo "✅ BUILD COMPLETE!"
echo "=========================================="
echo "Build finished: $(date)"
echo ""
echo "📊 Build Summary:"
echo "  ✅ Client built successfully"
echo "  ✅ Server built successfully"
echo "  ✅ Assets copied to dist/public/"
echo "  ✅ Environment config in place"
echo ""
echo "📦 Output structure:"
ls -la dist/ | head -10 || true
echo ""
echo "🚀 Ready for deployment!"
echo "=========================================="