import { afterEach, describe, expect, it, vi } from "vitest";
import { searchLctrPostOffices } from "../src/lctr/postOfficeLookup.js";

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
});
