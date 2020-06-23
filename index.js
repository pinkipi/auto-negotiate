const CONTRACT_DEAL_REPLY = 35,
	CONTRACT_DEAL = 36

module.exports = function AutoNegotiate(mod) {
	mod.settings.$init({
		version: 1,
		defaults: {
			acceptThreshold: 1,				// 0 = Disabled
			rejectThreshold: 0.75,			// 0 = Disabled
			unattendManualNegotiate: false,
			delayActions: {
				enable: true,
				longRng: [1200, 2600],
				shortRng: [400, 800]
			}
		}
	})

	const { command } = mod.require

	const pendingDeals = [],
		recentDeals = new Map()
	let currentDeal = null,
		currentContract = null,
		actionTimer = null,
		cancelTimer = null,
		lastErrorTimestamp = 0

	mod.hook('S_TRADE_BROKER_DEAL_SUGGESTED', 1, event => {
		const dealId = BigInt(event.playerId) << 32n | BigInt(event.listing)

		// Remove prior now-invalid deal
		for(let i = 0; i < pendingDeals.length; i++) {
			const deal = pendingDeals[i]

			if(deal.playerId === event.playerId && deal.listing === event.listing) {
				pendingDeals.splice(i--, 1)
				break
			}
		}
		// Remove recent deal
		{
			const oldDeal = recentDeals.get(dealId)
			if(oldDeal) {
				recentDeals.delete(dealId)
				mod.clearTimeout(oldDeal.timeout)
			}
		}

		// Handle this deal proxy-side
		if(comparePrice(event.sellerPrice, event.offeredPrice) !== 0) {
			pendingDeals.push(event)
			queueNextDeal()
			return false
		}
		// Temporarily store deal info for unattended manual negotiation
		else if(mod.settings.unattendManualNegotiate) {
			event.timeout = mod.setTimeout(() => { recentDeals.delete(dealId) }, 30000)
			recentDeals.set(dealId, event)
		}
	})

	mod.hook('S_REQUEST_CONTRACT', 2, event => {
		if(currentDeal && (event.type === CONTRACT_DEAL_REPLY || event.type === CONTRACT_DEAL)) {
			currentContract = event
			resetInactiveTimeout()

			if(event.type === CONTRACT_DEAL) {
				const parsed = {
					tradeId: event.param.readUInt32LE(0),
					itemId: event.param.readInt32LE(4),
					itemAmount: event.param.readInt32LE(8),
					itemEnchant: event.param.readInt32LE(12),
					sellerPrice: event.param.readBigInt64LE(16),
					offeredPrice: event.param.readBigInt64LE(24),
					fee: event.param.readBigInt64LE(32),
					isSeller: !!event.param[40],
					junk: event.param[41],									// BHS forgot to initialize this byte :')
					buyerName: event.param.slice(42, 116).toString('ucs2'),	// ...and these strings
					sellerName: event.param.slice(116, 190).toString('ucs2'),
					unidentifiedItemGrade: event.param.readInt32LE(190),
					masterwork: !!event.param[194],
					awakened: !!event.param[195],
					unbindCount: event.param.readInt32LE(196)
				}
				parsed.buyerName = parsed.buyerName.slice(0, parsed.buyerName.indexOf('\0'))
				parsed.sellerName = parsed.sellerName.slice(0, parsed.sellerName.indexOf('\0'))

				// Sanity check
				if(parsed.tradeId !== currentDeal.listing
					|| parsed.itemId !== currentDeal.item
					|| parsed.itemAmount !== currentDeal.amount
					|| parsed.itemEnchant !== currentDeal.enchant
					|| parsed.sellerPrice !== currentDeal.sellerPrice
					|| !parsed.isSeller
					|| parsed.buyerName !== currentDeal.name
					|| parsed.sellerName !== event.sourceName
				) {
					endDeal(true)
					command.message('Error: Negotiation contract mismatch.')
					return false
				}
				// Note: This can trigger if the buyer sends a second, lower priced offer before our response reaches the server
				if(comparePrice(currentDeal.sellerPrice, parsed.offeredPrice) !== 1) {
					endDeal(true)
					command.message('Negotiation terminated: Price mismatch.')
					return false
				}
			}
			return false
		}
	})

	mod.hook('S_TRADE_BROKER_REQUEST_DEAL_RESULT', 1, event => {
		if(currentDeal) {
			if(!event.ok) endDeal() // Deal was expired, so we move on to the next one

			return false
		}
	})

	mod.hook('S_TRADE_BROKER_DEAL_INFO_UPDATE', 1, event => {
		if(currentDeal) {
			if(event.buyerStage === 2 && event.sellerStage < 2)
				actionTimer = mod.setTimeout(() => {
					if(event.price >= currentDeal.offeredPrice)
						mod.send('C_TRADE_BROKER_DEAL_CONFIRM', 1, {
							listing: currentDeal.listing,
							stage: event.sellerStage + 1
						})
					// Note: This should never happen unless this packet changed or an exploit is introduced
					else {
						endDeal(true)
						command.message('Error: Price was lowered during negotiation!')
					}
				}, event.sellerStage === 0 ? rng(mod.settings.delayActions.shortRng) : 0)

			return false
		}
	})

	mod.hook('S_REPLY_REQUEST_CONTRACT', 1, replyOrAccept)
	mod.hook('S_ACCEPT_CONTRACT', 1, replyOrAccept)

	function replyOrAccept(event) {
		if(currentDeal && event.type === CONTRACT_DEAL_REPLY) {
			resetInactiveTimeout()
			return false
		}
	}

	mod.hook('S_CANCEL_CONTRACT', 1, event => {
		if(currentDeal && (event.type === CONTRACT_DEAL_REPLY || event.type === CONTRACT_DEAL)) {
			lastErrorTimestamp = Date.now()
			currentContract = null
			endDeal()
			return false
		}
	})

	mod.hook('S_TIMEOVER_CONTRACT', 1, event => {
		if(currentDeal && (event.type === CONTRACT_DEAL_REPLY || event.type === CONTRACT_DEAL)) {
			command.message('Negotiation timed out.')

			lastErrorTimestamp = Date.now()
			currentContract = null
			endDeal()
			return false
		}
	})

	mod.hook('S_REJECT_CONTRACT', 1, event => {
		if(currentDeal && (event.type === CONTRACT_DEAL_REPLY || event.type === CONTRACT_DEAL)) {
			command.message(currentDeal.name + ' aborted negotiation.')

			// Fix listing becoming un-negotiable (server-side) if the other user aborts the initial dialog
			if(event.type === CONTRACT_DEAL_REPLY)
				mod.send('C_TRADE_BROKER_REJECT_SUGGEST', 1, {
					playerId: currentDeal.playerId,
					listing: currentDeal.listing
				})

			lastErrorTimestamp = Date.now()
			currentContract = null
			endDeal()
			return false
		}
	})

	mod.hook('S_SYSTEM_MESSAGE', 1, event => {
		if(currentDeal || lastErrorTimestamp >= Date.now() - 1000)
			try {
				const msg = mod.parseSystemMessage(event.message)

				switch(msg.id) {
					case 'SMT_MEDIATE_TRADE_CANCEL_ME':
						lastErrorTimestamp = 0
						command.message('Negotiation interrupted.')
						return false
					case 'SMT_MEDIATE_TRADE_CANCEL_OPPONENT':
						if(currentDeal) {
							command.message(currentDeal.name + ' cancelled negotiation.')
							return false
						}
					case 'SMT_MEDIATE_DISCONNECT_CANCEL_OFFER_BY_ME': // C_TRADE_BROKER_REJECT_SUGGEST error message
						lastErrorTimestamp = 0
						return false
				}
			}
			catch(e) {}
	})

	// Handle unattended manual negotiations
	mod.hook('C_REQUEST_CONTRACT', 2, event => {
		if(!mod.settings.unattendManualNegotiate) return

		if(event.type === CONTRACT_DEAL_REPLY) {
			const deal = recentDeals.get(BigInt(event.param.readUInt32LE(0)) << 32n | BigInt(event.param.readUInt32LE(4)))
			if(deal) {
				currentDeal = deal
				command.message('Handling negotiation with ' + currentDeal.name + '...')
				process.nextTick(() => { mod.send('S_REPLY_REQUEST_CONTRACT', 1, { type: event.type }) })
			}
		}
	})

	function queueNextDeal(fast) {
		if(!currentDeal && !actionTimer)
			actionTimer = mod.setTimeout(tryNextDeal, rng(fast ? mod.settings.delayActions.shortRng : mod.settings.delayActions.longRng))
	}

	function tryNextDeal() {
		clearTimeout(actionTimer)
		actionTimer = null

		if(!(currentDeal = pendingDeals.shift())) return

		if(comparePrice(currentDeal.sellerPrice, currentDeal.offeredPrice) === 1) {
			command.message(`Attempting to negotiate with ${currentDeal.name}...`)
			command.message(`Price: ${formatGold(currentDeal.sellerPrice)} - Offered: ${formatGold(currentDeal.offeredPrice)}`)

			const param = Buffer.alloc(30)
			param.writeUInt32LE(currentDeal.playerId, 0)
			param.writeUInt32LE(currentDeal.listing, 4)
			mod.send('C_REQUEST_CONTRACT', 2, { type: 35, param })
		}
		else {
			command.message(`Declined negotiation from ${currentDeal.name}.`)
			command.message(`Price: ${formatGold(currentDeal.sellerPrice)} - Offered: ${formatGold(currentDeal.offeredPrice)}`)

			mod.send('C_TRADE_BROKER_REJECT_SUGGEST', 1, { playerId: currentDeal.playerId, listing: currentDeal.listing })
			lastErrorTimestamp = Date.now()
			currentDeal = null
			queueNextDeal(true)
		}
	}

	function resetInactiveTimeout() {
		mod.clearTimeout(cancelTimer)
		cancelTimer = mod.setTimeout(endDeal, pendingDeals.length ? 15000 : 30000)
	}

	function endDeal(silent) {
		mod.clearTimeout(actionTimer)
		mod.clearTimeout(cancelTimer)

		if(currentContract) {
			mod.send('C_CANCEL_CONTRACT', 1, { type: currentContract.type, id: currentContract.id })
			// In case the server never replies
			currentContract = null
			resetInactiveTimeout()

			if(!silent) command.message('Negotiation timed out.')
			return
		}

		currentDeal = null
		queueNextDeal(true)
	}

	// 1 = Auto Accept, 0 = No Action, -1 = Auto-decline
	function comparePrice(sellerPrice, offeredPrice) {
		// Convert from BigInt since 48 bits is still higher than the maximum broker price
		sellerPrice = Number(sellerPrice)
		offeredPrice = Number(offeredPrice)

		const acceptThreshold = mod.settings.acceptThreshold,
			rejectThreshold = mod.settings.rejectThreshold

		if(acceptThreshold > 0 && offeredPrice >= acceptThreshold * sellerPrice) return 1
		if(rejectThreshold > 0 && offeredPrice < rejectThreshold * sellerPrice) return -1
		return 0
	}

	function rng([min, max]) {
		return mod.settings.delayActions.enable ? min + Math.floor(Math.random() * (max - min + 1)) : 0
	}
}

function formatGold(gold) {
	gold = gold.toString()

	let str = ''
	if(gold.length > 4) str += '<font color="#ffb033">' + Number(gold.slice(0, -4)).toLocaleString() + 'g</font>'
	if(gold.length > 2) str += '<font color="#d7d7d7">' + gold.slice(-4, -2) + 's</font>'
	str += '<font color="#c87551">' + gold.slice(-2) + 'c</font>'

	return str
}