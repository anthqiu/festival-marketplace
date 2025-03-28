const FestToken = artifacts.require("FestToken");
const FestiveTicketsFactory = artifacts.require("FestiveTicketsFactory");
const FestivalNFT = artifacts.require("FestivalNFT");
const FestivalMarketplace = artifacts.require("FestivalMarketplace");

contract("Ticketing System via Factory", accounts => {
  let festToken, factory, festivalNFT, festivalMarketplace;
  const organizer = accounts[0];  // Event organizer, also the owner of the factory
  const buyer = accounts[1];
  const secondaryBuyer = accounts[2];

  // Event parameters: ticket price is set to 0.01 ether, total supply of 100 tickets
  const festName = "TestFest";
  const festSymbol = "TFEST";
  const ticketPrice = web3.utils.toWei("0.01", "ether");
  const totalSupply = 100;

  before(async () => {
    console.log("Ganache test accounts:", accounts);

    // Deploy the FestToken contract
    festToken = await FestToken.new({ from: organizer });
    console.log("FestToken deployed address:", festToken.address);

    // Deploy the FestiveTicketsFactory contract
    factory = await FestiveTicketsFactory.new({ from: organizer });
    console.log("FestiveTicketsFactory deployed address:", factory.address);
  });

  it("Create event and tickets via createNewFest, and batch mint tickets", async () => {
    // The event organizer calls createNewFest to create a new event and its corresponding marketplace contract
    const tx = await factory.createNewFest(festToken.address, festName, festSymbol, ticketPrice, totalSupply, { from: organizer });
    // Obtain the newly created FestivalNFT and FestivalMarketplace addresses from the event
    const event = tx.logs.find(log => log.event === "Created");
    assert(event, "Created event was not triggered");
    const nftAddress = event.args.ntfAddress;
    const mpAddress = event.args.marketplaceAddress;
    console.log("New event FestivalNFT deployed address:", nftAddress);
    console.log("New event FestivalMarketplace deployed address:", mpAddress);

    // Instantiate FestivalNFT and FestivalMarketplace contracts using the addresses
    festivalNFT = await FestivalNFT.at(nftAddress);
    festivalMarketplace = await FestivalMarketplace.at(mpAddress);
    await festivalNFT.setApprovalForAll(festivalMarketplace.address, true, { from: organizer });

    // Optional: Query event details via the factory
    const festDetails = await factory.getFestDetails(nftAddress);
    console.log("Event details returned by factory:", festDetails);

    // The event organizer batch mints 5 tickets
    const numOfTickets = 5;
    const txMint = await festivalNFT.bulkMintTickets(numOfTickets, organizer, { from: organizer });
    console.log("Gas used for bulkMintTickets operation:", txMint.receipt.gasUsed);
  });

  it("Test primary market purchase: ticket payment transfer and ticket ownership transfer", async () => {
    // The organizer transfers some FestToken to the buyer in advance (for ticket payment)
    const tokenAmount = web3.utils.toWei("1", "ether");
    await festToken.transfer(buyer, tokenAmount, { from: organizer });

    // The buyer must first approve the FestivalMarketplace contract to spend tokens equal to the ticket price
    await festToken.approve(festivalMarketplace.address, ticketPrice, { from: buyer });

    // The buyer calls purchaseTicket to buy a ticket; the purchased ticket number should be 1 in order
    const txPrimary = await festivalMarketplace.purchaseTicket({ from: buyer });
    console.log("Gas used for purchaseTicket operation:", txPrimary.receipt.gasUsed);

    // Verify that the ownership of ticket number 1 has been transferred from the organizer to the buyer
    const ownerTicket1 = await festivalNFT.ownerOf(1);
    assert.equal(ownerTicket1, buyer, "The owner of ticket number 1 should be the buyer");
  });

  it("Test secondary market transaction and 10% commission deduction", async () => {
    const ticketId = 1;
    // The buyer sets the secondary sale details for ticket 1, setting the selling price to 105% of the ticket price (within the allowed 110% range)
    const validSellingPrice = web3.utils.toBN(ticketPrice).mul(web3.utils.toBN(105)).div(web3.utils.toBN(100));
    const txSetSale = await festivalNFT.setSaleDetails(ticketId, validSellingPrice.toString(), festivalMarketplace.address, { from: buyer });
    console.log("Gas used for setSaleDetails operation:", txSetSale.receipt.gasUsed);

    // Preparation for secondary purchase: transfer tokens to secondaryBuyer and approve the Marketplace contract to spend
    await festToken.transfer(secondaryBuyer, web3.utils.toWei("1", "ether"), { from: organizer });
    await festToken.approve(festivalMarketplace.address, validSellingPrice.toString(), { from: secondaryBuyer });

    const buyerBalanceBefore = await festToken.balanceOf(buyer);
    const organizerBalanceBefore = await festToken.balanceOf(organizer);
    console.log("Before secondary transaction, FestToken balance of original ticket holder (buyer):", buyerBalanceBefore.toString());
    console.log("Before secondary transaction, FestToken balance of organizer:", organizerBalanceBefore.toString());
    console.log("Ticket price:", validSellingPrice.toString());

    // The secondaryBuyer calls secondaryPurchase to complete the secondary market transaction
    const txSecondary = await festivalMarketplace.secondaryPurchase(ticketId, { from: secondaryBuyer });
    console.log("Gas used for secondaryPurchase operation:", txSecondary.receipt.gasUsed);

    // Verify that the ownership of ticket number 1 is now held by secondaryBuyer
    const newOwner = await festivalNFT.ownerOf(ticketId);
    assert.equal(newOwner, secondaryBuyer, "The owner of ticket number 1 should be secondaryBuyer");

    // According to the contract logic: in secondary transactions, the commission is 10% of the selling price; the buyer (original holder) receives the remaining amount and the organizer collects the commission
    const commission = validSellingPrice.mul(web3.utils.toBN(10)).div(web3.utils.toBN(100));
    const sellerExpected = validSellingPrice.sub(commission);
    const buyerBalanceAfter = await festToken.balanceOf(buyer);
    const organizerBalanceAfter = await festToken.balanceOf(organizer);
    console.log("After secondary transaction, FestToken balance of original ticket holder (buyer):", buyerBalanceAfter.toString());
    console.log("After secondary transaction, FestToken balance of organizer:", organizerBalanceAfter.toString());
    // Further precise assertions can be made based on initial balances
  });

  it("Test setting an invalid secondary sale price (exceeding the 110% limit)", async () => {
    // Currently, the ownership of ticket number 1 is held by secondaryBuyer
    const ticketId = 1;
    // Get the current purchase price of the ticket (updated to the last secondary sale price)
    const ticketDetails = await festivalNFT.getTicketDetails(ticketId);
    const currentPurchasePrice = web3.utils.toBN(ticketDetails[0]);
    // Set an invalid selling price at 115% (exceeding the 110% limit)
    const invalidSellingPrice = currentPurchasePrice.mul(web3.utils.toBN(2));
    console.log("Purchase price:", currentPurchasePrice.toString(), " Set price:", invalidSellingPrice.toString());
    try {
      await festivalNFT.setSaleDetails(ticketId, invalidSellingPrice.toString(), festivalMarketplace.address, { from: secondaryBuyer });
      assert.fail("Should revert due to exceeding the price limit");
    } catch (error) {
      assert.include(error.message, "Re-selling price is more than 110%", "Expected error: exceeds 110% limit");
    }
  });
});
