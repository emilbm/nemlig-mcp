import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The real page nests these in ribbons; pickFavouritesGroup only sees the flattened
// spots, so these fixtures are what the in-page walk produces.
const SPOTS = [
  { heading: 'Har du husket dine favoritter?', productGroupId: '10040a7d', totalProducts: 150 },
  { heading: 'Anbefalinger til dig', productGroupId: '80da84c3', totalProducts: 45 },
  { heading: 'Populært lige nu', productGroupId: '2f8c3a54', totalProducts: 45 },
  { heading: 'Se et udvalg af vores nye varer', productGroupId: '34112834', totalProducts: 53 },
];

describe('favourites group discovery', () => {
  it('picks the favourites list out of the lists beside it', async () => {
    const { pickFavouritesGroup } = await import('../dist/src/nemlig/login.js');
    assert.equal(pickFavouritesGroup(SPOTS), '10040a7d');
  });

  it('explains what it found when nothing matches, instead of guessing', async () => {
    const { pickFavouritesGroup } = await import('../dist/src/nemlig/login.js');
    const renamed = SPOTS.map((spot) => ({ ...spot, heading: spot.heading.replace(/favoritter/i, 'yndlingsvarer') }));

    assert.throws(
      () => pickFavouritesGroup(renamed),
      (error) => {
        assert.match(error.message, /yndlingsvarer/, 'the error should list what was actually on the page');
        assert.match(error.message, /NEMLIG_FAVOURITES_HEADING/);
        return true;
      },
    );
  });

  it('reports an empty page rather than returning nothing useful', async () => {
    const { pickFavouritesGroup } = await import('../dist/src/nemlig/login.js');
    assert.throws(() => pickFavouritesGroup([]), /no spots at all/);
  });
});
