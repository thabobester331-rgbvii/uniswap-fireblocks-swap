
import os

# Create directory
base_dir = "/mnt/agents/output/uniswap-fireblocks-swap/src/uniswap-api"
os.makedirs(base_dir, exist_ok=True)

# File 1: quote.ts
quote_ts = '''/**
 * Uniswap API + Fireblocks - Quote Module
 * 
 * Approach 2: Direct Uniswap API integration with Fireblocks transaction signing.
 * Provides full control over routing and execution.
 * 
 * Prerequisites:
 * - Uniswap API key from developers.uniswap.org/dashboard
 * - Fireblocks API key with Raw Transaction permissions
 * - Policy rules allowing contract calls to Uniswap contracts
 */

import {
  getConfig,
  SwapError,
  handleError,
  getTokenAddress,
  formatAmount,
} from "../config";

// ==========================================
// Types
// ==========================================

export interface UniswapQuoteRequest {
  tokenIn: string;          // Token address or symbol
  tokenOut: string;         // Token address or symbol
  amount: string;           // Human-readable amount
  type: "EXACT_INPUT" | "EXACT_OUTPUT";
  chainId?: number;
  swapper: string;          // User wallet address (Fireblocks vault)
  slippageTolerance?: number; // Percentage (e.g., 0.5)
  recipient?: string;       // Optional: different recipient
  enableUniversalRouter?: boolean;
  enableErc20Eth?: boolean; // For UniswapX native ETH input
}

export interface UniswapQuote {
  quoteId: string;
  routing: string;            // CLASSIC, DUTCH_V2, DUTCH_V3, PRIORITY, WRAP, UNWRAP, BRIDGE
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  price: string;
  priceImpact: number;
  gasUseEstimate: string;
  route: any[];
  permitData: any | null;
  quote: any;               // Raw quote for execution
  rawResponse: any;
}

// ==========================================
// Quote Request Builder
// ==========================================

function resolveTokenAddress(token: string, chainId: number): string {
  // If it's already an address (0x...), return as-is
  if (token.startsWith("0x") && token.length === 42) {
    return token;
  }
  // Otherwise resolve symbol to address
  return getTokenAddress(chainId, token);
}

export async function getUniswapQuote(
  request: UniswapQuoteRequest
): Promise<UniswapQuote> {
  const config = getConfig();
  const chainId = request.chainId || config.blockchain.chainId;
  
  const tokenInAddress = resolveTokenAddress(request.tokenIn, chainId);
  const tokenOutAddress = resolveTokenAddress(request.tokenOut, chainId);
  
  // Determine decimals for formatting (simplified - should query token contract)
  const isNativeIn = tokenInAddress === "0x0000000000000000000000000000000000000000";
  const decimalsIn = isNativeIn ? 18 : 6; // Simplified - ETH=18, most ERC20=6 or 18
  
  const amountInBaseUnits = formatAmount(request.amount, decimalsIn);
  
  const headers: Record<string, string> = {
    "x-api-key": config.uniswapApi.apiKey,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  
  // Enable ERC20ETH for UniswapX native ETH input
  if (request.enableErc20Eth && isNativeIn) {
    headers["x-erc20eth-enabled"] = "true";
  }
  
  const body = {
    tokenIn: tokenInAddress,
    tokenOut: tokenOutAddress,
    tokenInChainId: chainId,
    tokenOutChainId: chainId,
    type: request.type,
    amount: amountInBaseUnits,
    swapper: request.swapper,
    slippageTolerance: request.slippageTolerance || config.swap.defaultSlippageBps / 100,
    ...(request.recipient && { recipient: request.recipient }),
    ...(request.enableUniversalRouter && { enableUniversalRouter: true }),
  };
  
  try {
    const response = await fetch(`${config.uniswapApi.baseUrl}/quote`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new SwapError(
        `Uniswap API error: ${response.status} - ${errorData.error || response.statusText}`,
        "API_ERROR",
        errorData
      );
    }
    
    const data = await response.json();
    
    return {
      quoteId: data.quoteId || data.requestId || "unknown",
      routing: data.routing,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amount,
      amountOut: data.output?.amount || data.quote?.output?.amount || "0",
      price: data.price || data.quote?.price || "0",
      priceImpact: data.priceImpact || data.quote?.priceImpact || 0,
      gasUseEstimate: data.gasUseEstimate || data.quote?.gasUseEstimate || "0",
      route: data.route || data.quote?.route || [],
      permitData: data.permitData || data.quote?.permitData || null,
      quote: data.quote || data,
      rawResponse: data,
    };
  } catch (error) {
    if (error instanceof SwapError) throw error;
    return handleError(error, "Failed to get Uniswap quote");
  }
}

// ==========================================
// Routing Helpers
// ==========================================

export function getExecutionEndpoint(routing: string): string {
  const swapEndpoints = ["CLASSIC", "WRAP", "UNWRAP", "BRIDGE"];
  const orderEndpoints = ["DUTCH_V2", "DUTCH_V3", "PRIORITY"];
  
  if (swapEndpoints.includes(routing)) {
    return "/swap";
  }
  if (orderEndpoints.includes(routing)) {
    return "/order";
  }
  
  throw new SwapError(`Unknown routing type: ${routing}`, "UNKNOWN_ROUTING");
}

export function isGaslessRoute(routing: string): boolean {
  return ["DUTCH_V2", "DUTCH_V3", "PRIORITY"].includes(routing);
}

// ==========================================
// Multi-Quote Comparison
// ==========================================

export async function compareQuotes(
  requests: UniswapQuoteRequest[]
): Promise<UniswapQuote[]> {
  const quotes = await Promise.all(
    requests.map((req) =>
      getUniswapQuote(req).catch((err) => {
        console.warn(`Quote failed for ${req.tokenIn}→${req.tokenOut}:`, err);
        return null;
      })
    )
  );
  
  return quotes.filter((q): q is UniswapQuote => q !== null);
}

// ==========================================
// CLI / Direct Execution
// ==========================================

if (require.main === module) {
  (async () => {
    try {
      const config = getConfig();
      
      if (!config.uniswapApi.apiKey) {
        throw new Error("UNISWAP_API_KEY is required for Approach 2");
      }
      
      console.log("📊 Uniswap API Quote Example\\n");
      
      const quote = await getUniswapQuote({
        tokenIn: "ETH",
        tokenOut: "USDC",
        amount: "0.1",
        type: "EXACT_INPUT",
        chainId: 1,
        swapper: "0x0000000000000000000000000000000000000000", // Replace with actual vault
        slippageTolerance: 0.5,
      });
      
      console.log("✅ Quote received:");
      console.log(`   Quote ID: ${quote.quoteId}`);
      console.log(`   Routing: ${quote.routing}`);
      console.log(`   Input: ${quote.amountIn} ${quote.tokenIn}`);
      console.log(`   Output: ${quote.amountOut} ${quote.tokenOut}`);
      console.log(`   Price: ${quote.price}`);
      console.log(`   Price Impact: ${quote.priceImpact}%`);
      console.log(`   Gas Estimate: ${quote.gasUseEstimate}`);
      console.log(`   Execution Endpoint: ${getExecutionEndpoint(quote.routing)}`);
      console.log(`   Gasless: ${isGaslessRoute(quote.routing)}`);
      
      if (quote.permitData) {
        console.log("\\n⚠️  Permit signature required before execution");
      }
      
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  })();
}
'''

with open(f"{base_dir}/quote.ts", "w") as f:
    f.write(quote_ts)

print("Created quote.ts")
import os

# Create directory
base_dir = "/mnt/agents/output/uniswap-fireblocks-swap/src/uniswap-api"
os.makedirs(base_dir, exist_ok=True)

# File 1: quote.ts
quote_ts = '''/**
 * Uniswap API + Fireblocks - Quote Module
 * 
 * Approach 2: Direct Uniswap API integration with Fireblocks transaction signing.
 * Provides full control over routing and execution.
 * 
 * Prerequisites:
 * - Uniswap API key from developers.uniswap.org/dashboard
 * - Fireblocks API key with Raw Transaction permissions
 * - Policy rules allowing contract calls to Uniswap contracts
 */

import {
  getConfig,
  SwapError,
  handleError,
  getTokenAddress,
  formatAmount,
} from "../config";

// ==========================================
// Types
// ==========================================

export interface UniswapQuoteRequest {
  tokenIn: string;          // Token address or symbol
  tokenOut: string;         // Token address or symbol
  amount: string;           // Human-readable amount
  type: "EXACT_INPUT" | "EXACT_OUTPUT";
  chainId?: number;
  swapper: string;          // User wallet address (Fireblocks vault)
  slippageTolerance?: number; // Percentage (e.g., 0.5)
  recipient?: string;       // Optional: different recipient
  enableUniversalRouter?: boolean;
  enableErc20Eth?: boolean; // For UniswapX native ETH input
}

export interface UniswapQuote {
  quoteId: string;
  routing: string;            // CLASSIC, DUTCH_V2, DUTCH_V3, PRIORITY, WRAP, UNWRAP, BRIDGE
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  price: string;
  priceImpact: number;
  gasUseEstimate: string;
  route: any[];
  permitData: any | null;
  quote: any;               // Raw quote for execution
  rawResponse: any;
}

// ==========================================
// Quote Request Builder
// ==========================================

function resolveTokenAddress(token: string, chainId: number): string {
  // If it's already an address (0x...), return as-is
  if (token.startsWith("0x") && token.length === 42) {
    return token;
  }
  // Otherwise resolve symbol to address
  return getTokenAddress(chainId, token);
}

export async function getUniswapQuote(
  request: UniswapQuoteRequest
): Promise<UniswapQuote> {
  const config = getConfig();
  const chainId = request.chainId || config.blockchain.chainId;
  
  const tokenInAddress = resolveTokenAddress(request.tokenIn, chainId);
  const tokenOutAddress = resolveTokenAddress(request.tokenOut, chainId);
  
  // Determine decimals for formatting (simplified - should query token contract)
  const isNativeIn = tokenInAddress === "0x0000000000000000000000000000000000000000";
  const decimalsIn = isNativeIn ? 18 : 6; // Simplified - ETH=18, most ERC20=6 or 18
  
  const amountInBaseUnits = formatAmount(request.amount, decimalsIn);
  
  const headers: Record<string, string> = {
    "x-api-key": config.uniswapApi.apiKey,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  
  // Enable ERC20ETH for UniswapX native ETH input
  if (request.enableErc20Eth && isNativeIn) {
    headers["x-erc20eth-enabled"] = "true";
  }
  
  const body = {
    tokenIn: tokenInAddress,
    tokenOut: tokenOutAddress,
    tokenInChainId: chainId,
    tokenOutChainId: chainId,
    type: request.type,
    amount: amountInBaseUnits,
    swapper: request.swapper,
    slippageTolerance: request.slippageTolerance || config.swap.defaultSlippageBps / 100,
    ...(request.recipient && { recipient: request.recipient }),
    ...(request.enableUniversalRouter && { enableUniversalRouter: true }),
  };
  
  try {
    const response = await fetch(`${config.uniswapApi.baseUrl}/quote`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new SwapError(
        `Uniswap API error: ${response.status} - ${errorData.error || response.statusText}`,
        "API_ERROR",
        errorData
      );
    }
    
    const data = await response.json();
    
    return {
      quoteId: data.quoteId || data.requestId || "unknown",
      routing: data.routing,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amount,
      amountOut: data.output?.amount || data.quote?.output?.amount || "0",
      price: data.price || data.quote?.price || "0",
      priceImpact: data.priceImpact || data.quote?.priceImpact || 0,
      gasUseEstimate: data.gasUseEstimate || data.quote?.gasUseEstimate || "0",
      route: data.route || data.quote?.route || [],
      permitData: data.permitData || data.quote?.permitData || null,
      quote: data.quote || data,
      rawResponse: data,
    };
  } catch (error) {
    if (error instanceof SwapError) throw error;
    return handleError(error, "Failed to get Uniswap quote");
  }
}

// ==========================================
// Routing Helpers
// ==========================================

export function getExecutionEndpoint(routing: string): string {
  const swapEndpoints = ["CLASSIC", "WRAP", "UNWRAP", "BRIDGE"];
  const orderEndpoints = ["DUTCH_V2", "DUTCH_V3", "PRIORITY"];
  
  if (swapEndpoints.includes(routing)) {
    return "/swap";
  }
  if (orderEndpoints.includes(routing)) {
    return "/order";
  }
  
  throw new SwapError(`Unknown routing type: ${routing}`, "UNKNOWN_ROUTING");
}

export function isGaslessRoute(routing: string): boolean {
  return ["DUTCH_V2", "DUTCH_V3", "PRIORITY"].includes(routing);
}

// ==========================================
// Multi-Quote Comparison
// ==========================================

export async function compareQuotes(
  requests: UniswapQuoteRequest[]
): Promise<UniswapQuote[]> {
  const quotes = await Promise.all(
    requests.map((req) =>
      getUniswapQuote(req).catch((err) => {
        console.warn(`Quote failed for ${req.tokenIn}→${req.tokenOut}:`, err);
        return null;
      })
    )
  );
  
  return quotes.filter((q): q is UniswapQuote => q !== null);
}

// ==========================================
// CLI / Direct Execution
// ==========================================

if (require.main === module) {
  (async () => {
    try {
      const config = getConfig();
      
      if (!config.uniswapApi.apiKey) {
        throw new Error("UNISWAP_API_KEY is required for Approach 2");
      }
      
      console.log("📊 Uniswap API Quote Example\\n");
      
      const quote = await getUniswapQuote({
        tokenIn: "ETH",
        tokenOut: "USDC",
        amount: "0.1",
        type: "EXACT_INPUT",
        chainId: 1,
        swapper: "0x0000000000000000000000000000000000000000", // Replace with actual vault
        slippageTolerance: 0.5,
      });
      
      console.log("✅ Quote received:");
      console.log(`   Quote ID: ${quote.quoteId}`);
      console.log(`   Routing: ${quote.routing}`);
      console.log(`   Input: ${quote.amountIn} ${quote.tokenIn}`);
      console.log(`   Output: ${quote.amountOut} ${quote.tokenOut}`);
      console.log(`   Price: ${quote.price}`);
      console.log(`   Price Impact: ${quote.priceImpact}%`);
      console.log(`   Gas Estimate: ${quote.gasUseEstimate}`);
      console.log(`   Execution Endpoint: ${getExecutionEndpoint(quote.routing)}`);
      console.log(`   Gasless: ${isGaslessRoute(quote.routing)}`);
      
      if (quote.permitData) {
        console.log("\\n⚠️  Permit signature required before execution");
      }
      
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  })();
}
'''

with open(f"{base_dir}/quote.ts", "w") as f:
    f.write(quote_ts)

print("Created quote.ts")
