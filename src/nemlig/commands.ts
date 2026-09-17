import { config } from '../config.js';
import { NemligApiError, NemligClient, readJson } from './client.js';
import {
  summarizeProduct,
  type Basket,
  type ProductList,
  type ProductSummary,
  type SearchResult,
} from './types.js';

const { webBaseUrl, searchBaseUrl, searchPageSize } = config.nemlig;

/**
 * The basket is the anchor for everything else: search and favourites both need
 * its delivery slot to price and stock products correctly.
 */
export async function getBasket(client: NemligClient): Promise<Basket> {
  const response = await client.get(`${webBaseUrl}/webapi/basket/GetBasket`);
  return readJson<Basket>(response, 'fetch the basket');
}

export async function searchProducts(client: NemligClient, basket: Basket, term: string): Promise<ProductSummary[]> {
  const url = new URL('/searchgateway/api/search', searchBaseUrl);
  url.searchParams.set('query', term);
  url.searchParams.set('take', String(searchPageSize));
  url.searchParams.set('skip', '0');
  url.searchParams.set('timeslotUtc', basket.TimeslotUtc ?? '');
  url.searchParams.set('deliveryZoneId', String(basket.DeliveryZoneId ?? ''));
  url.searchParams.set('TimeSlotId', basket.DeliveryTimeSlot?.Id ?? '');

  const result = await readJson<SearchResult>(await client.get(url.toString()), `search for "${term}"`);
  return (result.Products?.Products ?? []).map(summarizeProduct);
}

export async function getFavouriteProducts(client: NemligClient, basket: Basket): Promise<ProductSummary[]> {
  const { userId, buildStamp, favouritesGroupId } = client.token;

  // Both of these are read off the site at login rather than pinned: the customer
  // id is whose list this is, and the stamp changes on every product reimport.
  const url = new URL(
    `/webapi/${buildStamp}/${basket.TimeslotUtc}/${basket.DeliveryZoneId}/${userId}/Products/GetByProductGroupId`,
    webBaseUrl,
  );
  url.searchParams.set('productGroupId', favouritesGroupId);
  url.searchParams.set('sortorder', 'default');

  const response = await client.get(url.toString(), { Referer: `${webBaseUrl}/favoritter/anbefalet-til-dig` });
  const result = await readJson<ProductList>(response, 'fetch favourite products');

  // An unexpected shape here used to read as "no favourites", which is how a stale
  // group id and an anonymous session both hid for as long as they did.
  if (!Array.isArray(result.Products)) {
    throw new NemligApiError(
      `Favourites came back without a Products array (keys: ${Object.keys(result).join(', ')}). ` +
        `Group id ${favouritesGroupId} was discovered from ${config.nemlig.sessionProbePath} at login, ` +
        `so the page's shape has probably changed.`,
      response.status,
      '',
    );
  }
  return result.Products.map(summarizeProduct);
}

/**
 * The household's favourites that are currently on promotion — Nemlig's own
 * "Favoritter på tilbud". Derived from the favourites list rather than from the
 * site-wide offers page, because /tilbud is every offer in the shop and says
 * nothing about whether this account buys the product.
 */
export async function getFavouritesOnOffer(client: NemligClient, basket: Basket): Promise<ProductSummary[]> {
  const favourites = await getFavouriteProducts(client, basket);
  return favourites.filter((product) => product.offer);
}

export interface AddToBasketResult {
  productId: string;
  /** How many this call put in. */
  added: number;
  /** How many are on the line now — the two differ when the basket already had some. */
  quantity: number;
}

/**
 * Despite its name, AddToBasket SETS a line's quantity rather than incrementing it:
 * posting 3 makes the line 3 however many were there before, and anything at or
 * below zero removes the line. Measured against the live API, because taking the
 * name at face value means add_to_basket(1) twice silently leaves you with one.
 *
 * Everything that writes goes through here, and every caller reads the current
 * quantity first so it can compute the absolute value it wants.
 */
async function setBasketQuantity(client: NemligClient, productId: string, quantity: number): Promise<void> {
  const response = await client.post(`${webBaseUrl}/webapi/basket/AddToBasket`, {
    AffectPartialQuantity: false,
    ProductId: productId,
    DisableQuantityValidation: false,
    Quantity: quantity,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new NemligApiError(
      `Failed to set product ${productId} to quantity ${quantity}: ${response.status} ${response.statusText} — ${body.slice(0, 500)}`,
      response.status,
      body,
    );
  }
}

/** The line for a product, if the basket currently has one. */
async function basketLineFor(client: NemligClient, productId: string) {
  const basket = await getBasket(client);
  return (basket.Lines ?? []).find((line) => (line.Id ?? line.ProductId) === productId);
}

export async function addToBasket(client: NemligClient, productId: string, quantity: number): Promise<AddToBasketResult> {
  // Read first: "add 2" has to become "set to whatever is there plus 2".
  const line = await basketLineFor(client, productId);
  const before = line?.Quantity ?? 0;
  const total = before + quantity;
  await setBasketQuantity(client, productId, total);
  return { productId, added: quantity, quantity: total };
}

export interface RemoveFromBasketResult {
  productId: string;
  name: string;
  removed: number;
  remaining: number;
}

/**
 * Takes items back out. Reads the basket first because the endpoint sets an
 * absolute quantity: removing 1 of 3 means setting the line to 2, and removing
 * more than is there means setting it to 0 rather than to a negative number.
 */
export async function removeFromBasket(
  client: NemligClient,
  productId: string,
  quantity?: number,
): Promise<RemoveFromBasketResult> {
  const line = await basketLineFor(client, productId);
  if (!line) {
    throw new NemligApiError(`Product ${productId} is not in the basket, so there is nothing to remove.`, 404, '');
  }

  const before = line.Quantity ?? 0;
  // Omitting the quantity means "take the whole line out".
  const remaining = quantity === undefined ? 0 : Math.max(0, before - quantity);
  await setBasketQuantity(client, productId, remaining);

  return {
    productId,
    name: line.Name ?? line.ProductName ?? productId,
    removed: before - remaining,
    remaining,
  };
}

