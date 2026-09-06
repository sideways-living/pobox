import { afterEach, describe, expect, it, vi } from "vitest";
import { rankedLocations, searchLctrPostOffices } from "../src/lctr/postOfficeLookup.js";

describe("LCTR post office lookup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps postcode results into selectable post office locations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "auspost-richmond-north",
            name: "Richmond North LPO",
            address1: "658 Church Street",
            suburb: "Richmond",
            state: "VIC",
            postcode: "3121",
            latitude: "-37.8206",
            longitude: "144.9992",
            phone: "(03) 9428 1111",
            hours_raw: "Mon-Fri 9:00-5:00"
          }
        ]
      })
    } as unknown as Response);

    const results = await searchLctrPostOffices("3121");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("postcode=3121");
    expect(results[0]).toMatchObject({
      sourceId: "auspost-richmond-north",
      name: "Richmond North LPO",
      address: "658 Church Street, Richmond, VIC, 3121",
      phone: "(03) 9428 1111",
      latitude: -37.8206,
      longitude: 144.9992
    });
  });

  it("resolves suburb searches through postcode lookup when LCTR postcode filtering is needed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("postcodes-lookup.csv")) {
        return {
          ok: true,
          text: async () => "Postcode,Suburb,State\n3121,RICHMOND,VIC\n"
        } as unknown as Response;
      }

      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "auspost-richmond-north",
              name: "Richmond North LPO",
              address1: "Victoria Street",
              suburb: "Richmond",
              state: "VIC",
              postcode: "3121",
              latitude: "-37.8108088",
              longitude: "145.0015614",
              phone: "+61 3 9428 1111"
            }
          ]
        })
      } as unknown as Response;
    });

    const results = await searchLctrPostOffices("Richmond");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("postcode=3121");
    expect(results[0]).toMatchObject({
      name: "Richmond North LPO",
      address: "Victoria Street, Richmond, VIC, 3121",
      phone: "+61 3 9428 1111"
    });
  });

  it("ranks typed name suggestions by prefix, word-start, then contains matches", () => {
    const results = rankedLocations([
      {
        sourceId: "south-melbourne",
        name: "South Melbourne LPO",
        address: "Clarendon Street, South Melbourne, VIC, 3205",
        suburb: "South Melbourne",
        postcode: "3205",
        state: "VIC",
        latitude: -37.8331,
        longitude: 144.9603
      },
      {
        sourceId: "fitzroy-south",
        name: "Fitzroy South Post Office",
        address: "Smith Street, Fitzroy, VIC, 3065",
        suburb: "Fitzroy",
        postcode: "3065",
        state: "VIC",
          latitude: -37.7999,
          longitude: 144.9829
      },
      {
        sourceId: "south-yarra",
        name: "South Yarra Post Office",
        address: "Toorak Road, South Yarra, VIC, 3141",
        suburb: "South Yarra",
        postcode: "3141",
        state: "VIC",
        latitude: -37.838,
        longitude: 144.992
      },
      {
        sourceId: "east-richmond",
        name: "East Richmond Post Office",
        address: "Swan Street, Richmond, VIC, 3121",
        suburb: "Richmond",
        postcode: "3121",
        state: "VIC",
        latitude: -37.825,
          longitude: 144.997
      },
      {
        sourceId: "kensington-south",
        name: "Kensington South Parcel Locker",
        address: "Bellair Street, Kensington, VIC, 3031",
        suburb: "Kensington",
        postcode: "3031",
        state: "VIC",
        latitude: -37.793,
        longitude: 144.93
      }
    ], "south");

    expect(results.map((result) => result.sourceId)).toEqual(["south-melbourne", "south-yarra", "fitzroy-south", "kensington-south"]);
    expect(results[0]).toMatchObject({ address: "Clarendon Street, South Melbourne, VIC, 3205", suburb: "South Melbourne", state: "VIC" });
  });

  it("matches typed substrings from suburb or address when the name does not match", () => {
    const results = rankedLocations([
      {
        sourceId: "market-street",
        name: "CBD Parcel Locker",
        address: "Market Street, South Melbourne, VIC, 3205",
        suburb: "South Melbourne",
        postcode: "3205",
        state: "VIC",
        latitude: -37.832,
        longitude: 144.959
      },
      {
        sourceId: "smith-street",
        name: "Fitzroy LPO",
        address: "Smith Street, Fitzroy, VIC, 3065",
        suburb: "Fitzroy",
        postcode: "3065",
        state: "VIC",
        latitude: -37.799,
        longitude: 144.982
      }
    ], "melb");

    expect(results.map((result) => result.sourceId)).toEqual(["market-street"]);
  });

  it("normalizes case, punctuation, and spacing in ranked suggestions", () => {
    const results = rankedLocations([
      {
        sourceId: "st-kilda",
        name: "St Kilda Post Office",
        address: "Acland Street, St Kilda, VIC, 3182",
        suburb: "St Kilda",
        postcode: "3182",
        state: "VIC",
        latitude: -37.866,
        longitude: 144.981
      },
      {
        sourceId: "kilda-road",
        name: "Melbourne Business Centre",
        address: "St Kilda Road, Melbourne, VIC, 3004",
        suburb: "Melbourne",
        postcode: "3004",
        state: "VIC",
        latitude: -37.821,
        longitude: 144.969
      }
    ], " ST.   KIL ");

    expect(results.map((result) => result.sourceId)).toEqual(["st-kilda", "kilda-road"]);
  });
});
