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

export interface Product {
  Id: string;
  Name: string;
  Price: number;
  Availability?: Availability;
  Labels?: string[];
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
  ProductId?: string;
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
}

export function summarizeProduct(product: Product): ProductSummary {
  return {
    id: product.Id,
    name: product.Name,
    price: product.Price,
    inStock: product.Availability?.IsAvailableInStock ?? true,
    deliverable: product.Availability?.IsDeliveryAvailable ?? true,
    labels: product.Labels ?? [],
  };
}
