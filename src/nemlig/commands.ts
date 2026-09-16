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
  quantity: number;
}

export async function addToBasket(client: NemligClient, productId: string, quantity: number): Promise<AddToBasketResult> {
  const response = await client.post(`${webBaseUrl}/webapi/basket/AddToBasket`, {
    AffectPartialQuantity: false,
    ProductId: productId,
    DisableQuantityValidation: false,
    Quantity: quantity,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new NemligApiError(
      `Failed to add product ${productId} to the basket: ${response.status} ${response.statusText} — ${body.slice(0, 500)}`,
      response.status,
      body,
    );
  }
  return { productId, quantity };
}
