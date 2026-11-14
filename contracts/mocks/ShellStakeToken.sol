// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";

contract ShellStakeToken is ZamaEthereumConfig, ERC7984 {
    uint64 private _payoutLimit = type(uint64).max;

    constructor() ERC7984("Shell test stake", "SHELL", "") {}

    function mint(address recipient, uint64 amount) external {
        _mint(recipient, FHE.asEuint64(amount));
    }

    function setPayoutLimit(uint64 amount) external {
        _payoutLimit = amount;
    }

    function confidentialTransfer(address to, euint64 amount) public override returns (euint64) {
        if (_payoutLimit == type(uint64).max) return super.confidentialTransfer(to, amount);
        return _transfer(msg.sender, to, FHE.min(amount, _payoutLimit));
    }
}
