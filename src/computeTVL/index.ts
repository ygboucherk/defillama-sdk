import { StringNumber, Address } from "../types";
import { multiCall } from "../abi";
import { humanizeNumber } from "./humanizeNumber";
import {
  getTokenPrices,
  getHistoricalTokenPrices,
  TokenPrices,
  GetCoingeckoLog,
} from "./prices";
import fetch from "node-fetch";
import {sumSingleBalance} from '../generalUtil'
import {Balances as NormalizedBalances} from '../types'

type Balances = {
  [tokenAddressOrName: string]: StringNumber | Object;
};

type ReturnedTokenBalances = {
  [tokenSymbolOrName: string]: number;
};

function tokenMulticall(addresses: Address[], abi: string, chain?: string) {
  return multiCall({
    abi,
    calls: addresses.map((address) => ({
      target: address,
      params: [],
    })),
    chain: chain as any,
  })
}

function addTokenBalance(
  balances: ReturnedTokenBalances,
  symbol: string,
  amount: number
) {
  balances[symbol] = (balances[symbol] || 0) + amount;
}

type ChainOrCoingecko = "bsc" | "ethereum" | "coingecko" | "polygon" | 'avax' | 'fantom' | 'xdai' | 'heco' | 'okexchain';
function historicalCoingeckoUrls(chain:ChainOrCoingecko){
  if(chain === 'coingecko'){
    return "https://api.coingecko.com/api/v3/coins"
  }
  const platformId = chainToCoingeckoId[chain]
  if(platformId!== undefined){
    return `https://api.coingecko.com/api/v3/coins/${platformId}/contract`
  }
  throw new Error("Chain not supported")
}

export const chainToCoingeckoId = {
  bsc: "binance-smart-chain",
  ethereum: "ethereum",
  polygon: "polygon-pos",
  avax: "avalanche",
  fantom: "fantom",
  xdai: "xdai",
  heco: "huobi-token",
  okexchain: "okex-chain",
  harmony: "harmony-shard-0",
  kcc: "kucoin-community-chain",
  "celo": "celo"
}

function currentCoingeckoUrls(chain:ChainOrCoingecko){
  if(chain === 'coingecko'){
    return "v3/simple/price?ids"
  }
  const platformId = chainToCoingeckoId[chain]
  if(platformId!== undefined){
    return `v3/simple/token_price/${platformId}?contract_addresses`
  }
  throw new Error("Chain not supported")
}

const chains = Object.keys(chainToCoingeckoId) as ChainOrCoingecko[];

async function getChainPrices(
  ids: {
    [chain: string]: string[];
  },
  timestamp: number | "now",
  knownTokenPrices: TokenPrices,
  getCoingeckoLock: GetCoingeckoLog,
  coingeckoMaxRetries: number
) {
  const chainPrices = {} as {
    [chain: string]: TokenPrices;
  };
  for (const chain of chains.concat(["coingecko"])) {
    if (ids[chain].length === 0) {
      chainPrices[chain] = {};
    } else {
      if (timestamp === "now") {
        chainPrices[chain] = await getTokenPrices(
          ids[chain],
          currentCoingeckoUrls(chain as ChainOrCoingecko),
          knownTokenPrices,
          getCoingeckoLock,
          coingeckoMaxRetries
        );
      } else {
        chainPrices[chain] = await getHistoricalTokenPrices(
          ids[chain],
          historicalCoingeckoUrls(chain as ChainOrCoingecko),
          timestamp,
          getCoingeckoLock,
          coingeckoMaxRetries
        );
      }
    }
  }
  return chainPrices;
}

function getChainSymbolsAndDecimals(ids: { [chain: string]: string[] }) {
  const allCoins = Object.entries(ids).map(chain=>chain[1].map(coin=>`${chain[0]}:${coin.toLowerCase()}`)).reduce((acc, coins)=>{
    coins.forEach(coin=>{
      acc.add(coin)
    })
    return acc
  }, new Set([] as string[]))
  return fetch('https://api.llama.fi/coins', {
    method: 'POST',
    body: JSON.stringify({
      coins: Array.from(allCoins)
    })
  }).then(response=>response.json())
}

export default async function (
  rawBalances: Balances,
  timestamp: number | "now",
  verbose: boolean = false,
  knownTokenPrices: TokenPrices = {},
  getCoingeckoLock: GetCoingeckoLog = () => Promise.resolve(),
  coingeckoMaxRetries: number = 3
) {
  let balances: Balances;
  if (rawBalances instanceof Array) {
    // Handle the cases where balances are returned in toSymbol format
    const callTokenDecimals = (
      await multiCall({
        abi: "erc20:decimals",
        calls: rawBalances.map((token) => ({
          target: token.address,
          params: [],
        })),
      })
    ).output;
    balances = rawBalances.reduce((acc, token, index) => {
      let dec: number;
      if (callTokenDecimals[index].success) {
        dec = Number(callTokenDecimals[index].output);
      } else {
        if (token.address === "0x0000000000000000000000000000000000000000") {
          dec = 18;
        } else {
          dec = NaN;
        }
      }
      acc[token.address] = (Number(token.balance) * 10 ** dec).toString();
      return acc;
    }, {});
  } else {
    balances = rawBalances;
  }
  const chainIds = {
    coingecko: [],
  } as {
    [chain:string]:Address[]
  };
  for(const chain of chains){
    chainIds[chain] = [];
  }

  const normalizedBalances = {} as NormalizedBalances;
  for (const tokenAddressOrName of Object.keys(balances)) {
    let normalizedAddressOrName = tokenAddressOrName;
    let normalizedBalance = balances[tokenAddressOrName];
    if (tokenAddressOrName === "0x0000000000000000000000000000000000000000") {
      normalizedAddressOrName = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"; // Normalize ETH to WETH
    }
    if (typeof normalizedBalance === "object") {
      normalizedBalances[
        normalizedAddressOrName
      ] = (normalizedBalance as any).toFixed(); // Some adapters return a BigNumber from bignumber.js so the results must be normalized
    } else {
      sumSingleBalance(normalizedBalances, normalizedAddressOrName, normalizedBalance)
    }
    if (normalizedAddressOrName.startsWith("0x")) {
      chainIds.ethereum.push(normalizedAddressOrName)
    } else if (normalizedAddressOrName.includes(":")) {
      const chain = normalizedAddressOrName.split(':')[0]
      chainIds[chain].push(normalizedAddressOrName.slice(chain.length+1))
    } else {
      chainIds.coingecko.push(normalizedAddressOrName)
    }
  }

  const symbolsAndDecimals = getChainSymbolsAndDecimals(chainIds);
  const allChainTokenPrices = await getChainPrices(
    chainIds,
    timestamp,
    knownTokenPrices,
    getCoingeckoLock,
    coingeckoMaxRetries
  );
  const usdTokenBalances = {} as ReturnedTokenBalances;
  const tokenBalances = {} as ReturnedTokenBalances;
  const usdAmounts = Object.entries(normalizedBalances).map(
    async ([address, balance]) => {
      let amount: number, price: number | undefined, tokenSymbol: string;
      try {
        if (address.startsWith("0x") || address.includes(":")) {
          let normalizedAddress = address;
          let chainSelector: ChainOrCoingecko = "ethereum";
          chains.forEach(chain=>{
            if(address.startsWith(chain)){
              chainSelector = chain;
              normalizedAddress = address.slice(chain.length +1);
            }
          })
          const chainTokenPrices = allChainTokenPrices[chainSelector];
          const chainAddress = `${chainSelector}:${normalizedAddress.toLowerCase()}`
          const coinData = (await symbolsAndDecimals).find((coin:any)=>coin.coin === chainAddress)

          tokenSymbol = coinData?.symbol?.toUpperCase()
          if (tokenSymbol === undefined || tokenSymbol === null) {
            tokenSymbol = `UNKNOWN (${address})`;
          }
          const tokenDecimals = coinData?.decimals
          if (tokenDecimals === undefined) {
            if (verbose) {
              console.warn(
                `Couldn't query decimals() for token ${tokenSymbol} (${address}) so we'll ignore and assume it's amount is 0`
              );
            }
            amount = 0;
          } else {
            amount = Number(balance) / 10 ** Number(tokenDecimals);
          }
          price = chainTokenPrices[normalizedAddress.toLowerCase()]?.usd;
        } else {
          tokenSymbol = address;
          price = allChainTokenPrices["coingecko"][address.toLowerCase()]?.usd;
          amount = Number(balance);
        }
        if (price === undefined) {
          if (verbose) {
            console.log(
              `Couldn't find the price of token at ${address}, assuming a price of 0 for it...`
            );
          }
          price = 0;
        }
        addTokenBalance(tokenBalances, tokenSymbol, amount);
        const usdAmount = amount * price;
        addTokenBalance(usdTokenBalances, tokenSymbol, usdAmount);
        return { usdAmount, tokenSymbol };
      } catch (e) {
        console.error(
          `Error on token ${address}, we'll just assume it's price is 0...`,
          e
        );
        return {
          usdAmount: 0,
          tokenSymbol: `ERROR ${address}`,
        };
      }
    }
  );
  if (verbose) {
    (await Promise.all(usdAmounts))
      .sort((a, b) => b.usdAmount - a.usdAmount)
      .map((token) => {
        console.log(
          token.tokenSymbol.padEnd(25, " "),
          humanizeNumber(token.usdAmount)
        );
      });
  }
  const usdTvl = (await Promise.all(usdAmounts)).reduce((sum, token) => {
    return sum + token.usdAmount;
  }, 0);
  return {
    usdTvl,
    usdTokenBalances,
    tokenBalances,
  };
}
