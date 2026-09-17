import { config } from '../config.js';
import { NemligClient, readJson } from './client.js';
import type { Basket, Offer, ProductSummary } from './types.js';

/**
 * The `productbff` API — Nemlig's newer, customer-aware backend-for-frontend. It
 * resolves the account from the token's `debitorId` claim (see login.ts), returns
 * prices in øre, and hands back the shelf-edge promotion text ready-made, so there
 * is nothing to reconstruct the way the legacy campaign types needed.
 */

interface BffCertificate {
  text: string;
}
interface BffCampaignLine {
  text: string;
  accessibilityText?: string;
}
interface BffCampaignBadge {
  primaryText?: string;
  secondaryText?: string | null;
  accessibilityText?: string;
}
interface BffProduct {
  id: string;
  title: string;
  price: number;
  priceOriginal?: number | null;
  priceDiscount?: number | null;
  certificates?: BffCertificate[];
  campaignLines?: BffCampaignLine[];
  campaignBadge?: BffCampaignBadge | null;
  availability?: { type?: string };
  isFavorite?: boolean;
}
interface BffProductList {
  contentType: string;
  header?: { title?: string };
  products?: BffProduct[];
}
interface BffPage {
  pageContent?: BffProductList[];
}

/** øre → kroner, kept to two decimals so floating error never leaks into a price. */
function kr(ore: number): number {
  return Math.round(ore) / 100;
}

/**
 * The lists on the favourites page. The section headed "Favoritter på tilbud" is
 * Nemlig's own curation of which favourites are on offer; the rest are the same
 * favourites grouped by category. Every product carries `isFavorite: true`.
 */
async function fetchFavouritesLists(client: NemligClient, basket: Basket): Promise<BffProductList[]> {
  const url = new URL('/productbff/api/web/page', config.nemlig.bffBaseUrl);
  url.searchParams.set('path', config.nemlig.bffFavouritesPath);
  url.searchParams.set('timeslotId', basket.DeliveryTimeSlot?.Id ?? '');

  const page = await readJson<BffPage>(await client.get(url.toString()), 'fetch favourites from productbff');
  return (page.pageContent ?? []).filter((section) => section.contentType === 'ProductList');
}

/** True when the product is genuinely discounted, as opposed to merely carrying a "God pris" tag. */
function isDiscounted(product: BffProduct): boolean {
  const badge = product.campaignBadge;
  const badgeIsSaving = !!badge && /spar/i.test(`${badge.secondaryText ?? ''} ${badge.primaryText ?? ''}`);
  return product.priceDiscount != null || (product.campaignLines?.length ?? 0) > 0 || badgeIsSaving;
}

/**
 * The promotion, flattened. The description is Nemlig's own shelf-edge wording
 * ("2 stk. 35,-", "Spar 4,76 kroner") rather than a reconstruction — it is what
 * the shopper actually sees, and cannot be subtly wrong. The numeric fields are
 * language-neutral for a model that wants to compare or total.
 */
function bffOffer(product: BffProduct): Offer | undefined {
  if (!isDiscounted(product)) return undefined;

  const line = product.campaignLines?.[0];
  const badge = product.campaignBadge;
  const description = line?.text ?? badge?.accessibilityText ?? badge?.primaryText ?? 'Tilbud';

  const percentMatch = badge?.primaryText?.match(/^(\d+)\s*%$/);
  const quantityMatch = line?.text.match(/^(?:mix\s+)?(\d+)\s*stk/i);

  const offer: Offer = {
    type: line ? 'MultiBuy' : percentMatch ? 'Percent' : 'Discount',
    description,
  };
  if (quantityMatch?.[1]) offer.minQuantity = Number(quantityMatch[1]);
  if (percentMatch?.[1]) offer.percent = Number(percentMatch[1]);
  if (product.priceDiscount != null) offer.savings = kr(product.priceDiscount);
  // A straight discount has a meaningful unit price; a multi-buy's deal is in the text.
  if (product.priceDiscount != null) offer.offerPrice = kr(product.price);
  return offer;
}

function summarize(product: BffProduct, offer: Offer | undefined): ProductSummary {
  const available = product.availability?.type === 'Available';
  return {
    id: product.id,
    name: product.title,
    price: kr(product.price),
    inStock: available,
    deliverable: available,
    labels: (product.certificates ?? []).map((certificate) => certificate.text),
    ...(offer ? { offer } : {}),
  };
}

/** Every favourite, de-duplicated across the category sections it may appear in. */
export async function getFavouriteProducts(client: NemligClient, basket: Basket): Promise<ProductSummary[]> {
  const lists = await fetchFavouritesLists(client, basket);
  const byId = new Map<string, ProductSummary>();
  for (const list of lists) {
    for (const product of list.products ?? []) {
      // The favourites page is all favourites today, but guard against a stray
      // recommendation section slipping products that the account never chose.
      if (product.isFavorite === false) continue;
      if (!byId.has(product.id)) byId.set(product.id, summarize(product, bffOffer(product)));
    }
  }
  return [...byId.values()];
}

const OFFER_SECTION = /favoritter/i;

/**
 * The favourites Nemlig itself lists as on offer — the "Favoritter på tilbud"
 * section. Trusting that section rather than re-deriving it means the tool agrees
 * with what the shopper sees on the page, down to which borderline deals count.
 */
export async function getFavouritesOnOffer(client: NemligClient, basket: Basket): Promise<ProductSummary[]> {
  const lists = await fetchFavouritesLists(client, basket);
  const section = lists.find((list) => OFFER_SECTION.test(list.header?.title ?? ''));
  if (!section) return [];
  return (section.products ?? []).map((product) =>
    // Section membership is Nemlig's own answer, so describe the offer even when
    // our own discount heuristic would have been unsure.
    summarize(product, bffOffer(product) ?? { type: 'Offer', description: product.campaignBadge?.accessibilityText ?? 'Tilbud' }),
  );
}
