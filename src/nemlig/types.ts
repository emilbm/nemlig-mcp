/** Shapes we read back from Nemlig's web API. Only the fields we actually use. */

export interface NemligToken {
  accessToken: string;
  /** Every cookie the login flow left behind, pre-joined into a Cookie header. */
  cookieHeader: string;
  acquiredAt: number;
  /** From the JWT's own `exp`. Nemlig issues five-minute tokens, so this is checked before every call. */
  expiresAt: number;
  /**
   * Nemlig's own customer id, read off a page's `Settings` after login. A token can
   * be valid while the website session is still anonymous, in which case this is
   * null — and account-scoped endpoints quietly return nothing instead of failing.
   * Treating it as required is what makes that state impossible to miss.
   */
  userId: string;
  /**
   * `Settings.CombinedProductsAndSitecoreTimestamp` — a cache-busting stamp Nemlig
   * changes whenever it reimports products or republishes content. It sits in the
   * path of the favourites URL, so it is read fresh at login rather than pinned.
   */
  buildStamp: string;
  /**
   * Sitecore content id of the favourites list, discovered from the same page that
   * confirms the session. Pinning it meant a republish silently emptied favourites;
   * rediscovering it on every login means that heals itself within one token life.
   */
  favouritesGroupId: string;
}

/** A product-list spot on a Sitecore page: which list, and how many are in it. */
export interface PageSpot {
  heading: string;
  productGroupId: string;
  totalProducts: number;
}

/** The subset of a Sitecore page's `Settings` block we rely on. */
export interface PageSettings {
  UserId: string | null;
  ZipCode: string;
  DeliveryZoneId: number;
  TimeslotUtc: string;
  CombinedProductsAndSitecoreTimestamp: string;
}

export interface Availability {
  IsAvailableInStock: boolean;
  IsDeliveryAvailable: boolean;
}

/**
 * Nemlig models every promotion as one of four campaign shapes. The fields that
 * matter differ per type, which is why `describeOffer` switches on `Type` rather
 * than trying to read one common "discount" field.
 */
export interface Campaign {
  Type: string;
  /** "2 for 77" style offers: buy this many, pay TotalPrice for the lot. */
  MinQuantity?: number;
  TotalPrice?: number;
  DiscountPercent?: number;
  DiscountSavings?: number;
  CampaignPrice?: number;
  IntervalEnd?: string;
}

export interface Product {
  Id: string;
  Name: string;
  Price: number;
  Availability?: Availability;
  Labels?: string[];
  Campaign?: Campaign | null;
  Description?: string;
  Brand?: string;
}

/** A promotion, flattened into something a model can compare across products. */
export interface Offer {
  /** Nemlig's type with its `ProductCampaign` prefix dropped. */
  type: string;
  /** One line a person would recognise from the shelf edge: "3 for 15 kr", "40% off". */
  description: string;
  minQuantity?: number;
  /** What the offer costs: the bundle total, or the discounted unit price. */
  offerPrice?: number;
  savings?: number;
  percent?: number;
  endsAt?: string;
}

export interface ProductList {
  NumFound?: number;
  Products: Product[];
}

export interface SearchResult {
  Products: ProductList;
}

export interface DeliveryTimeSlot {
  Id: string;
}

export interface Basket {
  BasketGuid: string;
  TimeslotUtc: string;
  DeliveryZoneId: number;
  DeliveryTimeSlot: DeliveryTimeSlot;
  /** Present on a real basket; absent in the trimmed model the C# version used. */
  TotalPrice?: number;
  Lines?: BasketLine[];
}

export interface BasketLine {
  /** A basket line identifies its product by `Id`; `ProductId` appears in some responses. */
  Id?: string;
  ProductId?: string;
  Name?: string;
  ProductName?: string;
  Quantity?: number;
  TotalPrice?: number;
}

/** The trimmed product shape we hand back to the model — small on purpose. */
export interface ProductSummary {
  id: string;
  name: string;
  price: number;
  inStock: boolean;
  deliverable: boolean;
  labels: string[];
  /** Present only when the product is actually on offer, so its absence means full price. */
  offer?: Offer;
}

export function summarizeProduct(product: Product): ProductSummary {
  const offer = product.Campaign ? describeOffer(product.Campaign) : undefined;
  return {
    id: product.Id,
    name: product.Name,
    price: product.Price,
    inStock: product.Availability?.IsAvailableInStock ?? true,
    deliverable: product.Availability?.IsDeliveryAvailable ?? true,
    labels: product.Labels ?? [],
    ...(offer ? { offer } : {}),
  };
}

/** Formats a DKK amount the Danish way, dropping the decimals when they are zero. */
function kr(amount: number): string {
  return Number.isInteger(amount) ? `${amount} kr` : `${amount.toFixed(2).replace('.', ',')} kr`;
}

export function describeOffer(campaign: Campaign): Offer {
  const type = campaign.Type.replace(/^ProductCampaign/, '');
  const base: Offer = {
    type,
    description: type,
    ...(campaign.MinQuantity ? { minQuantity: campaign.MinQuantity } : {}),
    ...(campaign.DiscountSavings ? { savings: campaign.DiscountSavings } : {}),
    ...(campaign.DiscountPercent ? { percent: campaign.DiscountPercent } : {}),
    ...(campaign.IntervalEnd ? { endsAt: campaign.IntervalEnd } : {}),
  };

  switch (campaign.Type) {
    // Buy N, pay TotalPrice for all N — the price only applies at that quantity.
    case 'ProductCampaignBuyXForY':
    case 'ProductCampaignMixOffer': {
      const mix = campaign.Type === 'ProductCampaignMixOffer' ? 'Mix ' : '';
      const quantity = campaign.MinQuantity ?? 0;
      const total = campaign.TotalPrice ?? campaign.CampaignPrice;
      return {
        ...base,
        ...(total === undefined ? {} : { offerPrice: total }),
        description: total === undefined ? `${mix}multi-buy` : `${mix}${quantity} for ${kr(total)}`,
      };
    }
    case 'ProductCampaignDiscountPercent':
      return {
        ...base,
        ...(campaign.CampaignPrice === undefined ? {} : { offerPrice: campaign.CampaignPrice }),
        description: `${campaign.DiscountPercent}% off${campaign.CampaignPrice === undefined ? '' : ` — now ${kr(campaign.CampaignPrice)}`}`,
      };
    case 'ProductCampaignDiscount':
      return {
        ...base,
        ...(campaign.CampaignPrice === undefined ? {} : { offerPrice: campaign.CampaignPrice }),
        description: campaign.DiscountSavings
          ? `Save ${kr(campaign.DiscountSavings)}`
          : `Now ${kr(campaign.CampaignPrice ?? 0)}`,
      };
    default:
      // An unknown type is still worth surfacing — better a bare label than dropping the offer.
      return base;
  }
}
