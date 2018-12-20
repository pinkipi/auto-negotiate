const TYPE_NEGOTIATION_PENDING = 35,
	TYPE_NEGOTIATION = 36

module.exports = function AutoNegotiate(mod) {
	mod.settings.$init({
		version: 1,
		defaults: {
			acceptThreshold: 1,
			rejectThreshold: 0.75,
			unattendManualNegotiate: false,
			delayActions: {
				enable: true,
				longRng: [1200, 2600],
				shortRng: [400, 800]
			}
		}
	})

	const {command} = mod.require

	let recentDeals = mod.settings.unattendManualNegotiate ? {} : null,
		pendingDeals = [],
		currentDeal = null,
		currentContract = null,
		actionTimeout = null,
		cancelTimeout = null

	mod.hook('S_TRADE_BROKER_DEAL_SUGGESTED', 1, event => {
		// Remove old deals that haven't been processed yet
		for(let i = 0; i < pendingDeals.length; i++) {
			let deal = pendingDeals[i]

			if(deal.playerId == event.playerId && deal.listing == event.listing) pendingDeals.splice(i--, 1)
		}

		if(comparePrice(event.offeredPrice, event.sellerPrice) != 0) {
			pendingDeals.push(event)
			queueNextDeal(true)
			return false
		}
		else if(mod.settings.unattendManualNegotiate) {
			let dealId = event.playerId + '-' + event.listing

			if(recentDeals[dealId]) clearTimeout(recentDeals[dealId].timeout)

			recentDeals[dealId] = event
			recentDeals[dealId].timeout = setTimeout(() => { delete recentDeals[dealId] }, 30000)
		}
	})

	mod.hook('S_TRADE_BROKER_REQUEST_DEAL_RESULT', 1, event => {
		if(currentDeal) {
			if(!event.ok) endDeal()

			return false
		}
	})

	mod.hook('S_TRADE_BROKER_DEAL_INFO_UPDATE', 1, event => {
		if(currentDeal) {
			if(event.buyerStage == 2 && event.sellerStage < 2) {
				let deal = currentDeal

				// This abandoned timeout is not a good design, but it's unlikely that it will cause any issues
				setTimeout(() => {
					if(currentDeal && deal.playerId == currentDeal.playerId && deal.listing == currentDeal.listing && Number(event.price) >= Number(currentDeal.offeredPrice)) {
						mod.send('C_TRADE_BROKER_DEAL_CONFIRM', 1, {
							listing: currentDeal.listing,
							stage: event.sellerStage + 1
						})
					}
					else endDeal() // We negotiated the wrong one, whoops! - TODO: Inspect S_REQUEST_CONTRACT.data for price and other info
				}, event.sellerStage == 0 ? rng(mod.settings.delayActions.shortRng) : 0)
			}

			return false
		}
	})

	mod.hook('S_REQUEST_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			currentContract = event
			setEndTimeout()
			return false
		}
	})

	mod.hook('S_REPLY_REQUEST_CONTRACT', 1, replyOrAccept)
	mod.hook('S_ACCEPT_CONTRACT', 1, replyOrAccept)

	mod.hook('S_REJECT_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			command.message(currentDeal.name + ' aborted negotiation.')

			// Fix listing becoming un-negotiable (server-side) if the other user aborts the initial dialog
			if(event.type == TYPE_NEGOTIATION_PENDING)
				mod.send('C_TRADE_BROKER_REJECT_SUGGEST', 1, {
					playerId: currentDeal.playerId,
					listing: currentDeal.listing
				})

			currentContract = null
			endDeal()
			return false
		}
	})

	mod.hook('S_CANCEL_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			currentContract = null
			endDeal()
			return false
		}
	})

	mod.hook('S_SYSTEM_MESSAGE', 1, event => {
		if(currentDeal) {
			try {
				const msg = mod.parseSystemMessage(event.message)

				//if(msg.id === 'SMT_MEDIATE_DISCONNECT_CANCEL_OFFER_BY_ME' || msg.id === 'SMT_MEDIATE_TRADE_CANCEL_ME') return false
				if(msg.id === 'SMT_MEDIATE_TRADE_CANCEL_OPPONENT') {
					command.message(currentDeal.name + ' cancelled negotiation.')
					return false
				}
			}
			catch(e) {}
		}
	})

	if(mod.settings.unattendManualNegotiate)
		mod.hook('C_REQUEST_CONTRACT', 1, event => {
			if(event.type == 35) {
				let deal = recentDeals[event.data.readUInt32LE(0) + '-' + event.data.readUInt32LE(4)]

				if(deal) {
					currentDeal = deal
					command.message('Handling negotiation with ' + currentDeal.name + '...')
					process.nextTick(() => {
						mod.send('S_REPLY_REQUEST_CONTRACT', 1, { type: event.type })
					})
				}
			}
		})

	function replyOrAccept(event) {
		if(currentDeal && event.type == TYPE_NEGOTIATION_PENDING) {
			setEndTimeout()
			return false
		}
	}

	// 1 = Auto Accept, 0 = No Action, -1 = Auto-decline
	function comparePrice(offer, seller) {
		if(mod.settings.acceptThreshold && Number(offer) >= Number(seller) * mod.settings.acceptThreshold) return 1
		if(mod.settings.rejectThreshold && Number(offer) < Number(seller) * mod.settings.rejectThreshold) return -1
		return 0
	}

	function queueNextDeal(slow) {
		if(!actionTimeout && !currentDeal)
			actionTimeout = setTimeout(tryNextDeal, rng(slow ? mod.settings.delayActions.longRng : mod.settings.delayActions.shortRng))
	}

	function tryNextDeal() {
		actionTimeout = null

		if(!(currentDeal = pendingDeals.shift())) return

		if(comparePrice(currentDeal.offeredPrice, currentDeal.sellerPrice) == 1) {
			command.message('Attempting to negotiate with ' + currentDeal.name + '...')
			command.message('Price: ' + formatGold(currentDeal.sellerPrice) + ' - Offered: ' + formatGold(currentDeal.offeredPrice))

			const data = Buffer.alloc(30)
			data.writeUInt32LE(currentDeal.playerId, 0)
			data.writeUInt32LE(currentDeal.listing, 4)

			mod.send('C_REQUEST_CONTRACT', 1, {
				type: 35,
				unk2: 0,
				unk3: 0,
				unk4: 0,
				name: '',
				data
			})
		}
		else {
			mod.send('C_TRADE_BROKER_REJECT_SUGGEST', 1, {
				playerId: currentDeal.playerId,
				listing: currentDeal.listing
			})

			command.message('Declined negotiation from ' + currentDeal.name + '.')
			command.message('Price: ' + formatGold(currentDeal.sellerPrice) + ' - Offered: ' + formatGold(currentDeal.offeredPrice))

			currentDeal = null
			queueNextDeal()
		}
	}

	function setEndTimeout() {
		clearTimeout(cancelTimeout)
		cancelTimeout = setTimeout(endDeal, pendingDeals.length ? 15000 : 30000)
	}

	function endDeal() {
		clearTimeout(cancelTimeout)

		if(currentContract) {
			command.message('Negotiation timed out.')

			mod.send('C_CANCEL_CONTRACT', 1, {
				type: currentContract.type,
				id: currentContract.id
			})
			currentContract = null
			setEndTimeout()
			return
		}

		currentDeal = null
		queueNextDeal()
	}

	function formatGold(gold) {
		gold = gold.toString()

		let str = ''
		if(gold.length > 4) str += '<font color="#ffb033">' + Number(gold.slice(0, -4)).toLocaleString() + 'g</font>'
		if(gold.length > 2) str += '<font color="#d7d7d7">' + gold.slice(-4, -2) + 's</font>'
		str += '<font color="#c87551">' + gold.slice(-2) + 'c</font>'

		return str
	}

	function rng([min, max]) {
		return mod.settings.delayActions.enable ? min + Math.floor(Math.random() * (max - min + 1)) : 0
	}
}